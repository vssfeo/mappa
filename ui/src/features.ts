import {
  pathLength,
  polygonArea,
  polygonPerimeter,
  type LonLat,
} from './geo.ts'
import { tr } from './locale.ts'

export type FeatureKind = 'line' | 'polygon'

/** A user-drawn line or polygon stored independently from measurements. */
export interface MapFeature {
  id: string
  name: string
  kind: FeatureKind
  /** Open ring for polygons: the closing vertex is added when rendering. */
  coordinates: LonLat[]
  color: string
  description?: string
}

export type FeatureMode = 'off' | 'draw-line' | 'draw-polygon' | 'edit'

export const MAX_FEATURES = 2_000
export const MAX_VERTICES = 10_000
export const MAX_FEATURE_NAME = 200

export const FEATURE_COLORS = [
  '#f4a261',
  '#4cc9f0',
  '#3ddc97',
  '#e76f51',
  '#b892ff',
  '#ffd166',
]

export function featureId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

const validPoint = (value: unknown): LonLat | null => {
  if (!Array.isArray(value) || value.length < 2) return null
  const lon = Number(value[0])
  const lat = Number(value[1])
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null
  return [lon, lat]
}

const validRing = (value: unknown): LonLat[] => {
  if (!Array.isArray(value)) return []
  const points = value
    .map(validPoint)
    .filter((point): point is LonLat => point !== null)
  return openRing(points)
}

/** Drops the repeated closing vertex from a GeoJSON-style ring. */
const openRing = (points: LonLat[]): LonLat[] => {
  if (points.length < 2) return points
  const first = points[0]
  const last = points[points.length - 1]
  if (first[0] === last[0] && first[1] === last[1]) {
    return points.slice(0, -1)
  }
  return points
}

const safeName = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_FEATURE_NAME) : fallback
}

const safeColor = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

interface GeoGeometry {
  type?: unknown
  coordinates?: unknown
}

/** Reads LineString/MultiLineString/Polygon/MultiPolygon GeoJSON. */
export function parseFeatureGeoJSON(text: string): MapFeature[] {
  let source: unknown
  try {
    source = JSON.parse(text)
  } catch {
    throw new Error(tr('Файл не является корректным JSON', 'The file is not valid JSON'))
  }
  const root = source as { type?: unknown; features?: unknown; geometry?: unknown }
  const rawFeatures =
    root.type === 'FeatureCollection' && Array.isArray(root.features)
      ? root.features
      : root.type === 'Feature'
        ? [root]
        : []

  const result: MapFeature[] = []
  let vertices = 0
  for (const raw of rawFeatures) {
    if (result.length >= MAX_FEATURES) break
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const feature = raw as {
      properties?: Record<string, unknown> | null
      geometry?: GeoGeometry | null
    }
    const geometry = feature.geometry
    if (!geometry || typeof geometry !== 'object') continue
    const properties = feature.properties ?? {}
    const color = safeColor(properties.color, FEATURE_COLORS[0])
    const description =
      typeof properties.description === 'string'
        ? properties.description.slice(0, 2000)
        : undefined
    const fallbackName =
      typeof properties.name === 'string'
      ? properties.name
      : tr('Объект', 'Feature')

    const push = (kind: FeatureKind, coordinates: LonLat[]) => {
      if (result.length >= MAX_FEATURES) return
      if (vertices + coordinates.length > MAX_VERTICES) return
      if (kind === 'line' && coordinates.length < 2) return
      if (kind === 'polygon' && coordinates.length < 3) return
      vertices += coordinates.length
      result.push({
        id: featureId(),
        name: safeName(properties.name, fallbackName),
        kind,
        coordinates,
        color,
        description,
      })
    }

    if (geometry.type === 'LineString') {
      const coordinates = Array.isArray(geometry.coordinates)
        ? geometry.coordinates
        : []
      const points = coordinates
        .map(validPoint)
        .filter((point): point is LonLat => point !== null)
      push('line', points)
    } else if (geometry.type === 'MultiLineString') {
      const lines = Array.isArray(geometry.coordinates)
        ? geometry.coordinates
        : []
      for (const line of lines) {
        if (!Array.isArray(line)) continue
        const points = line
          .map(validPoint)
          .filter((point): point is LonLat => point !== null)
        push('line', points)
      }
    } else if (geometry.type === 'Polygon') {
      const rings = Array.isArray(geometry.coordinates)
        ? geometry.coordinates
        : []
      const ring = Array.isArray(rings[0]) ? rings[0] : []
      push('polygon', validRing(ring))
    } else if (geometry.type === 'MultiPolygon') {
      const polygons = Array.isArray(geometry.coordinates)
        ? geometry.coordinates
        : []
      for (const polygon of polygons) {
        if (!Array.isArray(polygon)) continue
        const ring = Array.isArray(polygon[0]) ? polygon[0] : []
        push('polygon', validRing(ring))
      }
    }
  }
  return result
}

/** Serializes features as a standard WGS84 GeoJSON FeatureCollection. */
export function featuresToGeoJSON(features: MapFeature[]): string {
  const collection = {
    type: 'FeatureCollection',
    features: features.map((feature) => ({
      type: 'Feature',
      properties: {
        name: feature.name,
        kind: feature.kind,
        color: feature.color,
        ...(feature.description ? { description: feature.description } : {}),
        ...(feature.kind === 'line'
          ? { length_m: Math.round(featureLength(feature)) }
          : { area_m2: Math.round(featureArea(feature)) }),
      },
      geometry:
        feature.kind === 'line'
          ? { type: 'LineString', coordinates: feature.coordinates }
          : {
              type: 'Polygon',
              coordinates: [closeRing(feature.coordinates)],
            },
    })),
  }
  return `${JSON.stringify(collection, null, 2)}\n`
}

export const closeRing = (points: LonLat[]): LonLat[] => {
  if (points.length < 3) return points
  const first = points[0]
  const last = points[points.length - 1]
  if (first[0] === last[0] && first[1] === last[1]) return points
  return [...points, first]
}

export function featureLength(feature: MapFeature): number {
  if (feature.kind === 'polygon') return polygonPerimeter(feature.coordinates)
  return pathLength(feature.coordinates)
}

export function featureArea(feature: MapFeature): number {
  return feature.kind === 'polygon' ? polygonArea(feature.coordinates) : 0
}

/** Removes consecutive duplicates produced by double-click finishing. */
export function normalizeDraft(points: LonLat[]): LonLat[] {
  const result: LonLat[] = []
  for (const point of points) {
    const last = result[result.length - 1]
    if (last && last[0] === point[0] && last[1] === point[1]) continue
    result.push(point)
  }
  return result
}

export function draftReady(points: LonLat[], mode: 'draw-line' | 'draw-polygon') {
  return points.length >= (mode === 'draw-line' ? 2 : 3)
}
