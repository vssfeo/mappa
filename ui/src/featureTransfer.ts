/** Native file dialogs for user-drawn lines and polygons. */

import { open, save } from '@tauri-apps/plugin-dialog'
import {
  MAX_FEATURES,
  featuresToGeoJSON,
  parseFeatureGeoJSON,
  type MapFeature,
} from './features'
import { isNative, readTextFile, writeTextFile } from './native'
import { useAppStore } from './store'
import { tr } from './locale.ts'

const requireNative = () => {
  if (!isNative) {
    throw new Error(tr('Импорт и экспорт доступны в нативном приложении', 'Import and export are available in the native app'))
  }
}

export interface FeatureImport {
  features: MapFeature[]
  skipped: number
}

export async function importFeatureFile(): Promise<FeatureImport | null> {
  requireNative()
  const selected = await open({
    multiple: false,
    directory: false,
    title: tr('Импорт линий и полигонов', 'Import lines and polygons'),
    filters: [{ name: 'GeoJSON', extensions: ['geojson', 'json'] }],
  })
  const path = Array.isArray(selected) ? selected[0] : selected
  if (typeof path !== 'string' || path.length === 0) return null
  const text = await readTextFile(path)
  const parsed = parseFeatureGeoJSON(text)
  const existing = useAppStore.getState().features
  const room = Math.max(0, MAX_FEATURES - existing.length)
  const accepted = parsed.slice(0, room)
  if (accepted.length > 0) {
    useAppStore.getState().addFeatures(accepted)
  }
  return { features: accepted, skipped: parsed.length - accepted.length }
}

export async function exportFeatureFile(): Promise<string | null> {
  requireNative()
  const features = useAppStore.getState().features
  if (features.length === 0) {
    throw new Error(tr('Нет линий или полигонов для экспорта', 'No lines or polygons to export'))
  }
  const path = await save({
    title: tr('Экспорт линий и полигонов', 'Export lines and polygons'),
    defaultPath: 'mappa-features.geojson',
    filters: [{ name: 'GeoJSON', extensions: ['geojson'] }],
  })
  if (typeof path !== 'string' || path.length === 0) return null
  await writeTextFile(path, featuresToGeoJSON(features))
  return path
}
