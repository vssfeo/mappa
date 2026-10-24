/** Live GNSS position and track recording through the browser geolocation API. */

import { create } from 'zustand'
import {
  FEATURE_COLORS,
  featureId,
  type MapFeature,
} from './features.ts'
import { distance, type LonLat } from './geo.ts'

export type GpsStatus =
  | 'idle'
  | 'locating'
  | 'watching'
  | 'error'
  | 'unsupported'

export type GpsError = 'denied' | 'unavailable' | 'timeout' | 'watch'

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
}

interface GpsStore {
  supported: boolean
  status: GpsStatus
  error: GpsError | null
  fix: GpsFix | null
  recording: boolean
  paused: boolean
  samples: GpsFix[]
  startedAt: number | null
  follow: boolean
  startWatch: () => void
  stopWatch: () => void
  startRecording: () => void
  pauseRecording: () => void
  resumeRecording: () => void
  resetRecording: () => void
  setFollow: (follow: boolean) => void
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

export const useGpsStore = create<GpsStore>((set, get) => ({
  supported: geolocation() !== null,
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
  startWatch: () => {
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
        {
          enableHighAccuracy: true,
          maximumAge: 1000,
          timeout: 20_000,
        },
      )
    } catch {
      watchId = null
      set({ status: 'error', error: 'watch' })
    }
  },
  stopWatch: () => {
    const geo = geolocation()
    if (watchId !== null && geo) geo.clearWatch(watchId)
    watchId = null
    set({
      status: get().supported ? 'idle' : 'unsupported',
      paused: get().recording ? true : get().paused,
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
}))
