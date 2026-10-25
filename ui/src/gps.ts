/** Live GNSS position and track recording through the browser geolocation API. */

import { create } from 'zustand'
import {
  FEATURE_COLORS,
  featureId,
  type MapFeature,
} from './features.ts'
import { distance, type LonLat } from './geo.ts'
import { GpsdParser } from './gpsd.ts'
import {
  isNativeGnss,
  listenGnssStream,
  loadGnssEndpoint,
  normalizeGnssEndpoint,
  saveGnssEndpoint,
  startGnssTcp,
  stopGnssTcp,
  type GnssStreamKind,
  type StreamStatus,
} from './gnssTcp.ts'
import { NmeaParser, NmeaSimulator } from './nmea.ts'
import { useAppStore } from './store.ts'

export type GpsSource = 'browser' | 'nmea' | 'nmea-tcp' | 'gpsd'

export type GpsStatus =
  | 'idle'
  | 'locating'
  | 'watching'
  | 'error'
  | 'unsupported'

export type GpsError =
  | 'denied'
  | 'unavailable'
  | 'timeout'
  | 'watch'
  | 'nmea'
  | 'gpsd'

export interface GpsFix {
  lon: number
  lat: number
  /** Horizontal accuracy in metres. */
  accuracy: number
  altitude: number | null
  altitudeAccuracy: number | null
  /** Metres per second, when the device reports it. */
  speed: number | null
  /** Degrees clockwise from north, when the device reports it. */
  heading: number | null
  /** Milliseconds since epoch. */
  timestamp: number
  /** Where the fix came from. */
  source?: GpsSource
  /** Satellites used by an NMEA fix. */
  satellites?: number | null
  /** Horizontal dilution of precision from NMEA. */
  hdop?: number | null
  /** NMEA GGA quality code: 1 GPS, 2 DGPS, 4 RTK. */
  quality?: number | null
}

interface GpsStore {
  supported: boolean
  source: GpsSource
  status: GpsStatus
  error: GpsError | null
  fix: GpsFix | null
  recording: boolean
  paused: boolean
  samples: GpsFix[]
  startedAt: number | null
  follow: boolean
  simulationSpeed: number
  simulationStart: LonLat
  nmeaHost: string
  nmeaPort: number
  gpsdHost: string
  gpsdPort: number
  streamStatus: StreamStatus | 'idle'
  streamError: string | null
  nmeaLog: string[]
  startWatch: () => void
  stopWatch: () => void
  startRecording: () => void
  pauseRecording: () => void
  resumeRecording: () => void
  resetRecording: () => void
  setFollow: (follow: boolean) => void
  setSource: (source: GpsSource) => void
  setSimulationSpeed: (speed: number) => void
  setSimulationStart: (point: LonLat) => void
  setNmeaEndpoint: (host: string, port: number) => void
  setGpsdEndpoint: (host: string, port: number) => void
}

/** A new fix closer than this to the previous one is treated as jitter. */
export const GPS_MIN_DISTANCE = 2
/** Fixes worse than this horizontal accuracy are not written to the track. */
export const GPS_MAX_ACCURACY = 100
/** A stationary track still gets a point at this interval. */
export const GPS_IDLE_INTERVAL = 30_000

type RawGpsFix = {
  coords: {
    longitude: number
    latitude: number
    accuracy?: number | null
    altitude?: number | null
    altitudeAccuracy?: number | null
    speed?: number | null
    heading?: number | null
  }
  timestamp?: number
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Validates a `GeolocationPosition`-shaped value. */
export function normalizeGpsFix(value: RawGpsFix | null): GpsFix | null {
  if (!value || typeof value !== 'object' || !value.coords) return null
  const lon = finite(value.coords.longitude)
  const lat = finite(value.coords.latitude)
  const timestamp = finite(value.timestamp)
  if (lon === null || lat === null || timestamp === null) return null
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null
  const accuracy = finite(value.coords.accuracy)
  const speed = finite(value.coords.speed)
  const heading = finite(value.coords.heading)
  const altitude = finite(value.coords.altitude)
  const altitudeAccuracy = finite(value.coords.altitudeAccuracy)
  return {
    lon,
    lat,
    accuracy: accuracy !== null && accuracy >= 0 ? accuracy : 1000,
    altitude,
    altitudeAccuracy:
      altitudeAccuracy !== null && altitudeAccuracy >= 0
        ? altitudeAccuracy
        : null,
    speed: speed !== null && speed >= 0 ? speed : null,
    heading:
      heading !== null && heading >= 0 ? heading % 360 : null,
    timestamp,
    source: 'browser',
  }
}

/** Decides whether a fix belongs in the recorded track. */
export function shouldRecordFix(
  previous: GpsFix | null,
  next: GpsFix,
): boolean {
  if (next.accuracy > GPS_MAX_ACCURACY) return false
  if (!previous) return true
  if (next.timestamp <= previous.timestamp) return false
  const moved = distance(
    [previous.lon, previous.lat],
    [next.lon, next.lat],
  )
  return (
    moved >= GPS_MIN_DISTANCE ||
    next.timestamp - previous.timestamp >= GPS_IDLE_INTERVAL
  )
}

/** Converts recorded fixes into a regular line feature with a GPX profile. */
export function gpsTrackFeature(
  samples: GpsFix[],
  name: string,
  color = FEATURE_COLORS[0],
): MapFeature | null {
  if (samples.length < 2) return null
  const coordinates: LonLat[] = samples.map((sample) => [
    sample.lon,
    sample.lat,
  ])
  return {
    id: featureId(),
    name,
    kind: 'line',
    coordinates,
    color,
    profile: {
      elevations: samples.map((sample) => sample.altitude),
      times: samples.map((sample) => new Date(sample.timestamp).toISOString()),
    },
  }
}

const geolocation = (): Geolocation | null => {
  if (typeof navigator === 'undefined') return null
  return navigator.geolocation ?? null
}

let watchId: number | null = null
let simulationTimer: ReturnType<typeof setInterval> | null = null
let simulationKick: ReturnType<typeof setTimeout> | null = null
let simulator: NmeaSimulator | null = null
let externalCleanup: (() => void) | null = null
let externalParse: ((line: string) => GpsFix | null) | null = null
let externalToken = 0
let externalKind: GnssStreamKind | null = null

const powerProfile = () => {
  switch (useAppStore.getState().gpsPowerMode) {
    case 'precise':
      return { enableHighAccuracy: true, maximumAge: 1000, timeout: 20_000 }
    case 'saver':
      return { enableHighAccuracy: false, maximumAge: 15_000, timeout: 60_000 }
    default:
      return { enableHighAccuracy: true, maximumAge: 3_000, timeout: 30_000 }
  }
}

const simulationInterval = () =>
  useAppStore.getState().gpsPowerMode === 'saver' ? 3000 : 1000

const receiveFix = (fix: GpsFix) => {
  useGpsStore.setState((state) => {
    const previous = state.samples[state.samples.length - 1] ?? null
    const samples =
      state.recording &&
      !state.paused &&
      shouldRecordFix(previous, fix)
        ? [...state.samples, fix]
        : state.samples
    return {
      fix,
      samples,
      status: 'watching',
      error: null,
    }
  })
}

const locationError = (error: GeolocationPositionError): GpsError => {
  if (error.code === 1) return 'denied'
  if (error.code === 2) return 'unavailable'
  if (error.code === 3) return 'timeout'
  return 'watch'
}

const tickNmea = () => {
  if (!simulator) return
  const { sentences, fix } = simulator.step(Date.now())
  useGpsStore.setState({ nmeaLog: sentences.slice(-4) })
  if (fix) receiveFix(fix)
}

const startNmeaWatch = () => {
  if (simulationTimer !== null) return
  const state = useGpsStore.getState()
  const start: LonLat = state.fix
    ? [state.fix.lon, state.fix.lat]
    : state.simulationStart
  simulator = new NmeaSimulator(start, state.simulationSpeed)
  useGpsStore.setState({ status: 'locating', error: null, nmeaLog: [] })
  simulationKick = setTimeout(tickNmea, 120)
  simulationTimer = setInterval(tickNmea, simulationInterval())
}

const stopNmeaWatch = () => {
  if (simulationKick !== null) {
    clearTimeout(simulationKick)
    simulationKick = null
  }
  if (simulationTimer !== null) {
    clearInterval(simulationTimer)
    simulationTimer = null
  }
  simulator = null
}

const stopExternalWatch = () => {
  externalToken += 1
  externalParse = null
  const cleanup = externalCleanup
  externalCleanup = null
  const kind = externalKind
  externalKind = null
  cleanup?.()
  if (kind) void stopGnssTcp(kind).catch(() => {})
}

const makeParser = (
  kind: GnssStreamKind,
): ((line: string) => GpsFix | null) => {
  if (kind === 'nmea') {
    const parser = new NmeaParser()
    return (line) => {
      parser.push(line)
      return parser.fix()
    }
  }
  const parser = new GpsdParser()
  return (line) => parser.push(line)
}

const startExternalWatch = async (kind: GnssStreamKind) => {
  const current = useGpsStore.getState()
  if (
    externalKind === kind &&
    (current.status === 'watching' || current.status === 'locating') &&
    current.streamStatus !== 'error'
  ) {
    return
  }
  stopExternalWatch()
  stopNmeaWatch()
  const token = externalToken
  const state = useGpsStore.getState()
  const endpoint =
    kind === 'nmea'
      ? normalizeGnssEndpoint(state.nmeaHost, state.nmeaPort)
      : normalizeGnssEndpoint(state.gpsdHost, state.gpsdPort)
  useGpsStore.setState({
    status: 'locating',
    error: null,
    nmeaLog: [],
    streamStatus: 'connecting',
    streamError: null,
  })

  if (!isNativeGnss() || !endpoint.host) {
    useGpsStore.setState({
      status: 'error',
      error: kind,
      streamStatus: 'error',
    })
    return
  }

  externalKind = kind
  externalParse = makeParser(kind)
  const fixSource: GpsSource = kind === 'nmea' ? 'nmea-tcp' : 'gpsd'
  try {
    const cleanup = await listenGnssStream(
      kind,
      (line) => {
        if (token !== externalToken || !externalParse) return
        useGpsStore.setState((current) => ({
          nmeaLog: [...current.nmeaLog, line].slice(-8),
        }))
        const fix = externalParse(line)
        if (fix) receiveFix({ ...fix, source: fixSource })
      },
      (stream) => {
        if (token !== externalToken) return
        useGpsStore.setState({
          streamStatus: stream.status,
          streamError:
            stream.status === 'error'
              ? (stream.message ?? 'GNSS stream error')
              : null,
        })
      },
    )
    if (token !== externalToken) {
      cleanup()
      return
    }
    externalCleanup = cleanup
    await startGnssTcp(kind, endpoint.host, endpoint.port)
    if (token !== externalToken) {
      void stopGnssTcp(kind).catch(() => {})
    }
  } catch (error) {
    if (token !== externalToken) return
    const cleanup = externalCleanup
    externalCleanup = null
    cleanup?.()
    externalKind = null
    useGpsStore.setState({
      status: 'error',
      error: kind,
      streamStatus: 'error',
      streamError:
        error instanceof Error ? error.message : String(error),
    })
  }
}

const initialNmeaEndpoint = loadGnssEndpoint('nmea')
const initialGpsdEndpoint = loadGnssEndpoint('gpsd')

export const useGpsStore = create<GpsStore>((set, get) => ({
  supported: geolocation() !== null,
  source: 'browser',
  status:
    typeof navigator !== 'undefined' && geolocation() === null
      ? 'unsupported'
      : 'idle',
  error: null,
  fix: null,
  recording: false,
  paused: false,
  samples: [],
  startedAt: null,
  follow: true,
  simulationSpeed: 5,
  simulationStart: [37.6173, 55.7558],
  nmeaHost: initialNmeaEndpoint.host,
  nmeaPort: initialNmeaEndpoint.port,
  gpsdHost: initialGpsdEndpoint.host,
  gpsdPort: initialGpsdEndpoint.port,
  streamStatus: 'idle',
  streamError: null,
  nmeaLog: [],
  startWatch: () => {
    if (get().source === 'nmea') {
      startNmeaWatch()
      return
    }
    if (get().source === 'nmea-tcp') {
      void startExternalWatch('nmea')
      return
    }
    if (get().source === 'gpsd') {
      void startExternalWatch('gpsd')
      return
    }
    const geo = geolocation()
    if (!geo) {
      set({ supported: false, status: 'unsupported' })
      return
    }
    if (watchId !== null) return
    set({ status: 'locating', error: null })
    try {
      watchId = geo.watchPosition(
        (position) => {
          const fix = normalizeGpsFix(position)
          if (fix) receiveFix(fix)
        },
        (error) => {
          set({ status: 'error', error: locationError(error) })
        },
        powerProfile(),
      )
    } catch {
      watchId = null
      set({ status: 'error', error: 'watch' })
    }
  },
  stopWatch: () => {
    const source = get().source
    const external = source === 'nmea-tcp' || source === 'gpsd'
    if (source === 'nmea') {
      stopNmeaWatch()
    } else if (external) {
      stopExternalWatch()
    } else {
      const geo = geolocation()
      if (watchId !== null && geo) geo.clearWatch(watchId)
      watchId = null
    }
    set({
      status:
        source === 'browser' && !get().supported ? 'unsupported' : 'idle',
      paused: get().recording ? true : get().paused,
      streamStatus: external ? 'idle' : get().streamStatus,
      streamError: external ? null : get().streamError,
    })
  },
  startRecording: () => {
    get().startWatch()
    const fix = get().fix
    set({
      recording: true,
      paused: false,
      samples: fix ? [fix] : [],
      startedAt: fix ? fix.timestamp : Date.now(),
    })
  },
  pauseRecording: () => set({ paused: true }),
  resumeRecording: () => set({ paused: false }),
  resetRecording: () =>
    set({
      recording: false,
      paused: false,
      samples: [],
      startedAt: null,
    }),
  setFollow: (follow) => set({ follow }),
  setSource: (source) => {
    if (get().source === source) return
    get().stopWatch()
    set({
      source,
      fix: null,
      nmeaLog: [],
      error: null,
      status: source === 'browser' && !get().supported ? 'unsupported' : 'idle',
      streamStatus: 'idle',
      streamError: null,
    })
  },
  setSimulationSpeed: (speed) => {
    const clamped = Math.max(0, Math.min(50, speed))
    simulator?.setSpeed(clamped)
    set({ simulationSpeed: clamped })
  },
  setSimulationStart: (simulationStart) => set({ simulationStart }),
  setNmeaEndpoint: (host, port) => {
    const endpoint = normalizeGnssEndpoint(host, port)
    saveGnssEndpoint('nmea', endpoint.host, endpoint.port)
    set({ nmeaHost: endpoint.host, nmeaPort: endpoint.port })
  },
  setGpsdEndpoint: (host, port) => {
    const endpoint = normalizeGnssEndpoint(host, port)
    saveGnssEndpoint('gpsd', endpoint.host, endpoint.port)
    set({ gpsdHost: endpoint.host, gpsdPort: endpoint.port })
  },
}))
