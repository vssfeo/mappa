/** Native file dialogs for user-drawn lines and polygons. */

import { open, save } from '@tauri-apps/plugin-dialog'
import {
  FEATURE_COLORS,
  MAX_FEATURES,
  MAX_FEATURE_NAME,
  featureId,
  featuresToGeoJSON,
  featuresToGpx,
  parseFeatureGeoJSON,
  type MapFeature,
} from './features'
import type { LonLat } from './geo'
import { isNative, readTextFile, writeTextFile } from './native'
import { useAppStore } from './store'
import { tr } from './locale.ts'
import { parseVectorText, type VectorFeature } from './vectorLayers'

const requireNative = () => {
  if (!isNative) {
    throw new Error(tr('Импорт и экспорт доступны в нативном приложении', 'Import and export are available in the native app'))
  }
}

export interface FeatureImport {
  features: MapFeature[]
  skipped: number
}

const gpxTrack = (item: VectorFeature, index: number): MapFeature | null => {
  if (item.geometry.type !== 'LineString') return null
  const coordinates: LonLat[] = item.geometry.coordinates.map((coordinate) => [
    coordinate[0],
    coordinate[1],
  ])
  if (coordinates.length < 2) return null
  const properties = item.properties ?? {}
  const rawName =
    typeof properties.name === 'string' ? properties.name.trim() : ''
  const description =
    typeof properties.desc === 'string'
      ? properties.desc.trim().slice(0, 2_000)
      : ''
  return {
    id: featureId(),
    name: (rawName || tr('Трек', 'Track')).slice(0, MAX_FEATURE_NAME),
    kind: 'line',
    coordinates,
    color: FEATURE_COLORS[index % FEATURE_COLORS.length],
    ...(description ? { description } : {}),
    ...(item.profile ? { profile: item.profile } : {}),
  }
}

const parseGpxFeatures = (text: string): FeatureImport => {
  const parsed = parseVectorText(text, 'gpx')
  const features: MapFeature[] = []
  let skipped = 0
  for (const item of parsed.features) {
    const track = gpxTrack(item, features.length)
    if (track) features.push(track)
    else skipped += 1
  }
  return { features, skipped: skipped + parsed.skipped }
}

export async function importFeatureFile(): Promise<FeatureImport | null> {
  requireNative()
  const selected = await open({
    multiple: false,
    directory: false,
    title: tr(
      'Импорт линий, полигонов и треков',
      'Import lines, polygons and tracks',
    ),
    filters: [
      { name: 'GeoJSON / GPX', extensions: ['geojson', 'json', 'gpx'] },
    ],
  })
  const path = Array.isArray(selected) ? selected[0] : selected
  if (typeof path !== 'string' || path.length === 0) return null
  const text = await readTextFile(path)
  const parsed = /\.gpx$/i.test(path) || /<gpx\b/i.test(text.slice(0, 4_096))
    ? parseGpxFeatures(text)
    : { features: parseFeatureGeoJSON(text), skipped: 0 }
  const existing = useAppStore.getState().features
  const room = Math.max(0, MAX_FEATURES - existing.length)
  const accepted = parsed.features.slice(0, room)
  if (accepted.length > 0) {
    useAppStore.getState().addFeatures(accepted)
  }
  return {
    features: accepted,
    skipped: parsed.skipped + parsed.features.length - accepted.length,
  }
}

export type FeatureExportFormat = 'geojson' | 'gpx'

export async function exportFeatureFile(
  format: FeatureExportFormat = 'geojson',
): Promise<string | null> {
  requireNative()
  const features = useAppStore.getState().features
  if (features.length === 0) {
    throw new Error(tr('Нет линий или полигонов для экспорта', 'No lines or polygons to export'))
  }
  const gpx = format === 'gpx'
  const path = await save({
    title: gpx
      ? tr('Экспорт треков GPX', 'Export GPX tracks')
      : tr('Экспорт линий и полигонов', 'Export lines and polygons'),
    defaultPath: gpx ? 'mappa-features.gpx' : 'mappa-features.geojson',
    filters: [
      gpx
        ? { name: 'GPX', extensions: ['gpx'] }
        : { name: 'GeoJSON', extensions: ['geojson'] },
    ],
  })
  if (typeof path !== 'string' || path.length === 0) return null
  await writeTextFile(path, gpx ? featuresToGpx(features) : featuresToGeoJSON(features))
  return path
}
