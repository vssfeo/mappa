/** Portable `.mappa` project format: validation and (de)serialization. */

import {
  MAX_FEATURES,
  featuresToGeoJSON,
  parseFeatureGeoJSON,
  type MapFeature,
} from './features.ts'
import { tr } from './locale.ts'
import {
  MAX_MARKERS,
  markerId,
  type CoordinateFormat,
  type MapMarker,
} from './markers.ts'
import { PROVIDERS, type ProviderId } from './providers.ts'
import {
  MAX_VECTOR_FEATURES,
  MAX_VECTOR_LAYERS,
  sanitizeVectorLayer,
  type VectorLayer,
} from './vectorLayers.ts'

export const PROJECT_FORMAT = 'mappa-project'
export const PROJECT_VERSION = 1
export const MAX_PROJECT_BYTES = 64 * 1024 * 1024
export const MAX_PACKS = 64
export const MAX_CUSTOM_LAYERS = 256

export interface ProjectLayerState {
  visible: boolean
  opacity: number
}

export interface ProjectCrs {
  epsg?: number | null
  proj?: string | null
}

export interface ProjectView {
  center: [number, number]
  zoom: number
}

export interface MappaProject {
  format: typeof PROJECT_FORMAT
  version: typeof PROJECT_VERSION
  name: string
  savedAt: string
  providerId: ProviderId
  view: ProjectView
  layers: Record<ProviderId, ProjectLayerState>
  customLayers: Record<string, ProjectLayerState>
  packPaths: string[]
  markers: MapMarker[]
  features: { type: 'FeatureCollection'; features: unknown[] }
  vectorLayers: VectorLayer[]
  coordinateFormat: CoordinateFormat
  crs: ProjectCrs | null
  crsLabel: string
}

/** A validated project plus its runtime feature objects. */
export interface ParsedProject {
  file: MappaProject
  features: MapFeature[]
}

/** The subset of the app store that is written to a project. */
export interface ProjectSnapshot {
  name: string
  providerId: ProviderId
  view: ProjectView
  layers: Record<string, ProjectLayerState>
  customLayers: Record<string, ProjectLayerState>
  packPaths: string[]
  markers: MapMarker[]
  features: MapFeature[]
  vectorLayers: VectorLayer[]
  coordinateFormat: CoordinateFormat
  crs: ProjectCrs | null
  crsLabel: string
}

const safeText = (value: unknown, fallback: string, max: number): string => {
  if (typeof value !== 'string') return fallback
  const trimmed = value.replaceAll('\u0000', '').trim()
  return trimmed ? trimmed.slice(0, max) : fallback
}

const safeOpacity = (value: unknown, fallback = 1): number => {
  const opacity = Number(value)
  if (!Number.isFinite(opacity)) return fallback
  return Math.min(1, Math.max(0, opacity))
}

const layerMap = (
  value: unknown,
  fallbackVisible: boolean,
): Record<string, ProjectLayerState> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>).slice(
    0,
    MAX_CUSTOM_LAYERS,
  )
  const result: Record<string, ProjectLayerState> = {}
  for (const [id, layer] of entries) {
    if (!/^[a-z0-9_-]{1,48}$/.test(id)) continue
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue
    const record = layer as Record<string, unknown>
    result[id] = {
      visible:
        typeof record.visible === 'boolean'
          ? record.visible
          : fallbackVisible,
      opacity: safeOpacity(record.opacity),
    }
  }
  return result
}

const projectLayers = (
  value: unknown,
  active: ProviderId,
): Record<ProviderId, ProjectLayerState> => {
  const supplied = layerMap(value, true)
  const layers = Object.fromEntries(
    PROVIDERS.map((provider) => [
      provider.id,
      supplied[provider.id] ?? {
        visible: provider.id === active,
        opacity: 1,
      },
    ]),
  ) as Record<ProviderId, ProjectLayerState>
  // A project without a visible basemap looks broken; keep the active one on.
  layers[active].visible = true
  return layers
}

const projectView = (value: unknown): ProjectView => {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const center = Array.isArray(record.center) ? record.center : []
  const lon = Number(center[0])
  const lat = Number(center[1])
  const zoom = Number(record.zoom)
  return {
    center:
      Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      lon >= -180 &&
      lon <= 180 &&
      lat >= -90 &&
      lat <= 90
        ? [lon, lat]
        : [37.6173, 55.7558],
    zoom: Number.isFinite(zoom) ? Math.min(24, Math.max(0, zoom)) : 10,
  }
}

const projectMarkers = (value: unknown): MapMarker[] => {
  if (!Array.isArray(value)) return []
  const markers: MapMarker[] = []
  const ids = new Set<string>()
  for (const item of value.slice(0, MAX_MARKERS)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const lon = Number(record.lon)
    const lat = Number(record.lat)
    if (
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      lon < -180 ||
      lon > 180 ||
      lat < -90 ||
      lat > 90
    ) {
      continue
    }
    let id =
      typeof record.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(record.id)
        ? record.id
        : markerId()
    if (ids.has(id)) id = markerId()
    ids.add(id)
    const marker: MapMarker = {
      id,
      name: safeText(record.name, tr('Метка', 'Marker'), 200),
      lon,
      lat,
    }
    const elevation = Number(record.elevation)
    if (
      (typeof record.elevation === 'number' ||
        typeof record.elevation === 'string') &&
      Number.isFinite(elevation) &&
      elevation >= -12_000 &&
      elevation <= 12_000
    ) {
      marker.elevation = elevation
    }
    if (typeof record.description === 'string' && record.description.trim()) {
      marker.description = record.description.slice(0, 2_000)
    }
    if (typeof record.folder === 'string' && record.folder.trim()) {
      marker.folder = record.folder.trim().slice(0, 80)
    }
    if (typeof record.icon === 'string' && record.icon.trim()) {
      marker.icon = Array.from(record.icon.trim()).slice(0, 2).join('')
    }
    if (
      typeof record.color === 'string' &&
      /^#[0-9a-f]{6}$/i.test(record.color.trim())
    ) {
      marker.color = record.color.trim().toLowerCase()
    }
    markers.push(marker)
  }
  return markers
}

const projectFeatures = (value: unknown): MapFeature[] => {
  try {
    return parseFeatureGeoJSON(
      JSON.stringify(
        value ?? { type: 'FeatureCollection', features: [] },
      ),
    ).slice(0, MAX_FEATURES)
  } catch {
    return []
  }
}

const projectCrs = (value: unknown): ProjectCrs | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const epsg = Number(record.epsg)
  if (Number.isInteger(epsg) && epsg > 0 && epsg <= 999_999) {
    return { epsg }
  }
  if (typeof record.proj === 'string') {
    const proj = record.proj.trim()
    if (proj.length > 0 && proj.length <= 512 && !proj.includes('\u0000')) {
      return { proj }
    }
  }
  return null
}

const projectVectorLayers = (value: unknown): VectorLayer[] => {
  if (!Array.isArray(value)) return []
  const layers: VectorLayer[] = []
  let features = 0
  for (const item of value.slice(0, MAX_VECTOR_LAYERS)) {
    const layer = sanitizeVectorLayer(item, layers.length)
    if (!layer) continue
    // Bound the total across layers, not just per layer: a hostile project
    // must not multiply the import limits by the layer count.
    if (features + layer.features.length > MAX_VECTOR_FEATURES) continue
    features += layer.features.length
    layers.push(layer)
  }
  return layers
}

const projectPacks = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const paths: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const path = item.trim()
    if (
      path.length === 0 ||
      path.length > 4_096 ||
      path.includes('\u0000') ||
      path.includes('\n')
    ) {
      continue
    }
    if (!paths.includes(path)) paths.push(path)
    if (paths.length >= MAX_PACKS) break
  }
  return paths
}

export function buildProject(
  snapshot: ProjectSnapshot,
  savedAt = new Date().toISOString(),
): MappaProject {
  const active = snapshot.providerId
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: safeText(snapshot.name, tr('Мой проект', 'My project'), 120),
    savedAt,
    providerId: active,
    view: projectView(snapshot.view),
    layers: projectLayers(snapshot.layers, active),
    customLayers: layerMap(snapshot.customLayers, true),
    packPaths: projectPacks(snapshot.packPaths),
    markers: projectMarkers(snapshot.markers),
    features: JSON.parse(featuresToGeoJSON(snapshot.features)),
    vectorLayers: projectVectorLayers(snapshot.vectorLayers),
    coordinateFormat: snapshot.coordinateFormat,
    crs: projectCrs(snapshot.crs),
    crsLabel: safeText(snapshot.crsLabel, '', 120),
  }
}

/** Parses an untrusted `.mappa` file, clamping every collection. */
export function parseProject(text: string): ParsedProject {
  if (text.length > MAX_PROJECT_BYTES) {
    throw new Error(tr('Файл проекта слишком большой', 'The project file is too large'))
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(tr('Файл проекта повреждён: некорректный JSON', 'The project file is damaged: invalid JSON'))
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(tr('Файл проекта повреждён: ожидался объект', 'The project file is damaged: an object was expected'))
  }
  const record = raw as Record<string, unknown>
  if (record.format !== PROJECT_FORMAT || record.version !== PROJECT_VERSION) {
    throw new Error(tr('Неизвестный формат проекта', 'Unknown project format'))
  }
  const providerId = PROVIDERS.some(
    (provider) => provider.id === record.providerId,
  )
    ? (record.providerId as ProviderId)
    : PROVIDERS[0].id
  const features = projectFeatures(record.features)
  const coordinateFormat = ['dd', 'dms', 'utm', 'mgrs'].includes(
    String(record.coordinateFormat),
  )
    ? (record.coordinateFormat as CoordinateFormat)
    : 'dd'
  const file: MappaProject = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: safeText(record.name, tr('Мой проект', 'My project'), 120),
    savedAt:
      typeof record.savedAt === 'string'
        ? record.savedAt.slice(0, 40)
        : new Date().toISOString(),
    providerId,
    view: projectView(record.view),
    layers: projectLayers(record.layers, providerId),
    customLayers: layerMap(record.customLayers, true),
    packPaths: projectPacks(record.packPaths),
    markers: projectMarkers(record.markers),
    features: JSON.parse(featuresToGeoJSON(features)),
    vectorLayers: projectVectorLayers(record.vectorLayers),
    coordinateFormat,
    crs: projectCrs(record.crs),
    crsLabel: safeText(record.crsLabel, '', 120),
  }
  return { file, features }
}

export function serializeProject(project: MappaProject): string {
  return `${JSON.stringify(project, null, 2)}\n`
}

/** Fresh workspace used by “New project”. */
export function defaultProject(name = tr('Мой проект', 'My project')): MappaProject {
  const providerId = PROVIDERS[0].id
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: safeText(name, tr('Мой проект', 'My project'), 120),
    savedAt: new Date().toISOString(),
    providerId,
    view: { center: [37.6173, 55.7558], zoom: 10 },
    layers: projectLayers(undefined, providerId),
    customLayers: {},
    packPaths: [],
    markers: [],
    features: { type: 'FeatureCollection', features: [] },
    vectorLayers: [],
    coordinateFormat: 'dd',
    crs: null,
    crsLabel: '',
  }
}
