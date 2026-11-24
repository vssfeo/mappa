/** MERA GNSS RTK/PPK sidecar client and GeoJSON track parser. */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isNative } from './native.ts'

export type MeraSolver = 'fgo' | 'ekf'

export type MeraProfile =
  | 'core-causal'
  | 'core-causal-tuned'
  | 'core-lag10'
  | 'core-postprocess'

export interface MeraStatus {
  available: boolean
  binaryPath: string | null
  running: boolean
}

export interface MeraPpkRequest {
  roverPath: string
  basePath: string
  navPath: string
  atxPath?: string | null
  antBase?: string | null
  solver?: MeraSolver
  profile?: MeraProfile
  elevMaskDeg?: number
  cn0MinDbHz?: number
  outDir: string
  emitNmea?: boolean
}

export interface MeraProgressEvent {
  epoch: number
  total: number
  fixed: number
}

export interface MeraSummary {
  solver: string
  profile: string
  causalityMode: string
  epochs: number
  fixedEpochs: number
  fixedSharePct: number
  medianSigmaH_m: number
  wallSeconds: number
}

export interface MeraPpkResult {
  summary: MeraSummary
  outPos: string
  outGeojson: string
  outNmea: string | null
  outSummary: string
}

export interface MeraTrackSegment {
  quality: 'FIXED' | 'FLOAT'
  coordinates: [number, number][]
}

export interface ParsedMeraTrack {
  points: number
  fixedPoints: number
  center: [number, number] | null
  segments: MeraTrackSegment[]
  allCoordinates: [number, number][]
}

export const MERA_SOLVERS: {
  id: MeraSolver
  labelRu: string
  labelEn: string
}[] = [
  {
    id: 'fgo',
    labelRu: 'FGO v2 (фактор-граф, реком.)',
    labelEn: 'FGO v2 (factor graph, recommended)',
  },
  {
    id: 'ekf',
    labelRu: 'EKF v1 (фильтр Калмана)',
    labelEn: 'EKF v1 (Kalman filter)',
  },
]

export const MERA_PROFILES: {
  id: MeraProfile
  labelRu: string
  labelEn: string
}[] = [
  {
    id: 'core-causal',
    labelRu: 'Causal (онлайн, без задержки)',
    labelEn: 'Causal (real-time, zero lag)',
  },
  {
    id: 'core-causal-tuned',
    labelRu: 'Causal Tuned (город, онлайн)',
    labelEn: 'Causal Tuned (urban, real-time)',
  },
  {
    id: 'core-lag10',
    labelRu: 'Fixed-Lag 10 с (сглаживание)',
    labelEn: 'Fixed-Lag 10 s (smoothed)',
  },
  {
    id: 'core-postprocess',
    labelRu: 'Post-Process (RTS-сглаживание)',
    labelEn: 'Post-Process (RTS smoother)',
  },
]

export const meraPpkStatus = async (): Promise<MeraStatus | null> => {
  if (!isNative) return null
  try {
    return await invoke<MeraStatus>('mera_ppk_status')
  } catch {
    return null
  }
}

export const meraPpkRun = async (
  request: MeraPpkRequest,
): Promise<MeraPpkResult> => {
  if (!isNative) {
    throw new Error('MERA PPK is available in the desktop app only')
  }
  return invoke<MeraPpkResult>('mera_ppk_run', { request })
}

export const meraPpkCancel = async (): Promise<void> => {
  if (!isNative) return
  await invoke('mera_ppk_cancel')
}

export const onMeraProgress = async (
  handler: (event: MeraProgressEvent) => void,
): Promise<UnlistenFn> => {
  if (!isNative) return () => {}
  return listen<MeraProgressEvent>('mera://progress', (event) => {
    handler(event.payload)
  })
}

/**
 * Parse a `mera-rtk` GeoJSON FeatureCollection of Point samples into
 * contiguous FIXED/FLOAT track segments and a bounding-box centre.
 */
export const parseMeraGeoJsonTrack = (raw: string): ParsedMeraTrack => {
  const parsed = JSON.parse(raw) as {
    type?: string
    features?: {
      geometry?: { type?: string; coordinates?: unknown }
      properties?: { quality?: unknown; fixQuality?: unknown }
    }[]
  }
  const features = Array.isArray(parsed.features) ? parsed.features : []
  const allCoordinates: [number, number][] = []
  const segments: MeraTrackSegment[] = []
  let fixedPoints = 0
  let minLon = Infinity
  let maxLon = -Infinity
  let minLat = Infinity
  let maxLat = -Infinity

  for (const feature of features) {
    if (feature?.geometry?.type !== 'Point') continue
    const coords = feature.geometry.coordinates
    if (!Array.isArray(coords) || coords.length < 2) continue
    const lon = Number(coords[0])
    const lat = Number(coords[1])
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue

    const isFixed =
      feature.properties?.quality === 'FIXED' ||
      feature.properties?.fixQuality === 4
    const quality: 'FIXED' | 'FLOAT' = isFixed ? 'FIXED' : 'FLOAT'
    if (isFixed) fixedPoints += 1

    const pt: [number, number] = [lon, lat]
    allCoordinates.push(pt)
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat

    const last = segments[segments.length - 1]
    if (!last) {
      segments.push({ quality, coordinates: [pt] })
    } else if (last.quality === quality) {
      last.coordinates.push(pt)
    } else {
      // Overlap the junction vertex so the track renders without visual gaps.
      const prevPt = last.coordinates[last.coordinates.length - 1]
      segments.push({
        quality,
        coordinates: prevPt ? [prevPt, pt] : [pt],
      })
    }
  }

  const center: [number, number] | null =
    allCoordinates.length > 0
      ? [(minLon + maxLon) / 2, (minLat + maxLat) / 2]
      : null

  return {
    points: allCoordinates.length,
    fixedPoints,
    center,
    segments: segments.filter((seg) => seg.coordinates.length >= 2),
    allCoordinates,
  }
}
