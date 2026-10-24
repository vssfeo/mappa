/** Native file dialogs around marker import/export. */

import { open, save } from '@tauri-apps/plugin-dialog'
import {
  exportMarkers,
  importMarkers,
  MAX_MARKERS,
  type CoordinateFormat,
  type MarkerFileFormat,
  type MarkerImport,
} from './markers'
import { isNative, readTextFile, writeBinaryFile, writeTextFile } from './native'
import { createStoredZip } from './zip'
import { useAppStore } from './store'
import { tr } from './locale.ts'

const requireNative = () => {
  if (!isNative) {
    throw new Error(tr('Импорт и экспорт доступны в нативном приложении', 'Import and export are available in the native app'))
  }
}

export async function importMarkerFile(
  format: CoordinateFormat,
): Promise<MarkerImport | null> {
  requireNative()
  const selected = await open({
    multiple: false,
    directory: false,
    title: tr('Импорт меток', 'Import markers'),
    filters: [
      {
        name: tr('Метки', 'Markers'),
        extensions: [
          'geojson',
          'json',
          'csv',
          'txt',
          'gpx',
          'kml',
        ],
      },
    ],
  })
  const path = Array.isArray(selected) ? selected[0] : selected
  if (typeof path !== 'string' || path.length === 0) return null
  const text = await readTextFile(path)
  const result = importMarkers(text, format)
  const existing = useAppStore.getState().markers.length
  const room = Math.max(0, MAX_MARKERS - existing)
  const accepted = result.markers.slice(0, room)
  const overflow = result.markers.length - accepted.length
  if (accepted.length > 0) {
    useAppStore.getState().addMarkers(accepted)
  }
  return {
    markers: accepted,
    skipped: result.skipped + overflow,
  }
}

export async function exportMarkerFile(
  fileFormat: MarkerFileFormat,
  coordinateFormat: CoordinateFormat,
): Promise<string | null> {
  requireNative()
  const markers = useAppStore.getState().markers
  if (markers.length === 0) {
    throw new Error(tr('Нет меток для экспорта', 'No markers to export'))
  }
  const extension = fileFormat
  const names: Record<MarkerFileFormat, string> = {
    geojson: 'GeoJSON',
    csv: 'CSV',
    gpx: 'GPX',
    kml: 'KML',
    kmz: 'KMZ',
  }
  const path = await save({
    title: tr('Экспорт меток', 'Export markers'),
    defaultPath: `mappa-markers.${extension}`,
    filters: [{ name: names[fileFormat], extensions: [extension] }],
  })
  if (typeof path !== 'string' || path.length === 0) return null
  if (fileFormat === 'kmz') {
    const kml = exportMarkers(markers, 'kml', coordinateFormat)
    const archive = createStoredZip([
      { name: 'doc.kml', data: new TextEncoder().encode(kml) },
    ])
    await writeBinaryFile(path, archive)
  } else {
    const text = exportMarkers(markers, fileFormat, coordinateFormat)
    await writeTextFile(path, text)
  }
  return path
}
