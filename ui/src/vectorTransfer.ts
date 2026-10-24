/** Native dialogs around imported vector layers. */

import { open, save } from '@tauri-apps/plugin-dialog'
import { readKmz } from './kmz.ts'
import { parseShapefile } from './shp.ts'
import { reprojectFeatures } from './reproject.ts'
import { vectorLayerToKml } from './kmlExport.ts'
import { createStoredZip } from './zip.ts'
import {
  importGeoPackage,
  isNative,
  listGeoPackageLayers,
  readBinaryFile,
  writeBinaryFile,
  type GeoPackageLayer,
} from './native.ts'
import { useAppStore } from './store.ts'
import {
  defaultVectorStyle,
  parseVectorText,
  vectorLayerId,
  type VectorFormat,
  type VectorLayer,
} from './vectorLayers.ts'
import { tr } from './locale.ts'

const MAX_VECTOR_BYTES = 64 * 1024 * 1024

const requireNative = () => {
  if (!isNative) {
    throw new Error(tr('Импорт слоёв доступен в нативном приложении', 'Layer import is available in the native app'))
  }
}

function decodeText(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  if (view[0] === 0xff && view[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(view.subarray(2))
  }
  if (view[0] === 0xfe && view[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(view.subarray(2))
  }
  return new TextDecoder('utf-8').decode(view)
}

function baseName(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? name.slice(0, dot) : name).trim() || tr('Векторный слой', 'Vector layer')
}

export interface VectorImportResult {
  layer: VectorLayer
  skipped: number
  srs: string
}

export interface VectorImportOptions {
  /** Presents the tables of a multi-layer GeoPackage; null cancels. */
  chooseGeoPackageLayer?: (
    layers: GeoPackageLayer[],
  ) => Promise<string | null>
}

/** Opens a vector file and adds it as a layer. Returns null on cancel. */
export async function importVectorLayerFile(
  options: VectorImportOptions = {},
): Promise<VectorImportResult | null> {
  requireNative()
  const selected = await open({
    multiple: false,
    directory: false,
    title: tr('Импорт векторного слоя', 'Import a vector layer'),
    filters: [
      {
        name: tr('Векторы', 'Vector data'),
        extensions: ['geojson', 'json', 'gpx', 'kml', 'kmz', 'shp', 'gpkg'],
      },
    ],
  })
  const path = Array.isArray(selected) ? selected[0] : selected
  if (typeof path !== 'string' || path.length === 0) return null

  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  let features: VectorLayer['features']
  let skipped = 0
  let name = baseName(path)
  let format: VectorFormat
  let srs = ''

  if (extension === 'gpkg') {
    const tables = await listGeoPackageLayers(path)
    let table: string | undefined
    if (tables.length > 1 && options.chooseGeoPackageLayer) {
      const chosen = await options.chooseGeoPackageLayer(tables)
      if (!chosen) return null
      table = chosen
    } else if (tables.length > 0) {
      table = tables[0].name
    }
    const result = await importGeoPackage(path, table)
    if (result.name) name = result.name
    features = result.features as VectorLayer['features']
    skipped = result.skipped
    format = 'gpkg'
    srs = result.srs
  } else if (extension === 'shp') {
    const shp = await readBinaryFile(path)
    if (shp.byteLength > MAX_VECTOR_BYTES) {
      throw new Error(tr('Shapefile больше 64 МиБ', 'The shapefile is larger than 64 MiB'))
    }
    const dbf = await readBinaryFile(path.replace(/\.[^.\\/]+$/, '.dbf')).catch(
      () => null,
    )
    const prjBytes = await readBinaryFile(
      path.replace(/\.[^.\\/]+$/, '.prj'),
    ).catch(() => null)
    const prj = prjBytes ? decodeText(prjBytes) : null
    const parsed = parseShapefile(shp, dbf, prj, { deferProjection: true })
    features = parsed.features
    skipped = parsed.skipped
    format = 'shp'
    srs = parsed.srs
    if (parsed.projection) {
      const reprojected = await reprojectFeatures(features, parsed.projection)
      features = reprojected.features
      skipped += reprojected.skipped
    }
  } else {
    const bytes = await readBinaryFile(path)
    if (bytes.byteLength > MAX_VECTOR_BYTES) {
      throw new Error(tr('Векторный файл больше 64 МиБ', 'The vector file is larger than 64 MiB'))
    }
    let text: string
    if (extension === 'kmz') {
      text = await readKmz(bytes)
      format = 'kmz'
    } else {
      text = decodeText(bytes)
      format = extension === 'gpx' ? 'gpx' : extension === 'kml' ? 'kml' : 'geojson'
    }
    const parsed = parseVectorText(text, format === 'kmz' ? 'kml' : format)
    features = parsed.features
    skipped = parsed.skipped
    if (extension !== 'kmz') format = parsed.detected
  }

  if (features.length === 0) {
    throw new Error(tr('В файле нет поддерживаемых геометрий', 'The file has no supported geometries'))
  }
  const layers = useAppStore.getState().vectorLayers
  const layer: VectorLayer = {
    id: vectorLayerId(),
    name,
    format,
    features,
    style: defaultVectorStyle(layers.length),
    visible: true,
    opacity: 1,
    source: path,
  }
  useAppStore.getState().addVectorLayer(layer)
  return { layer, skipped, srs }
}

/** Saves an imported layer as KMZ (KML inside a stored ZIP). */
export async function exportVectorLayerKmz(
  layer: VectorLayer,
): Promise<string | null> {
  requireNative()
  const base =
    layer.name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim() ||
    'vector-layer'
  const selected = await save({
    title: tr('Экспорт векторного слоя в KMZ', 'Export the vector layer as KMZ'),
    defaultPath: `${base.slice(0, 80)}.kmz`,
    filters: [{ name: 'KMZ', extensions: ['kmz'] }],
  })
  if (typeof selected !== 'string' || selected.length === 0) return null
  const path = selected.toLowerCase().endsWith('.kmz')
    ? selected
    : `${selected}.kmz`
  const kml = vectorLayerToKml(layer)
  const archive = createStoredZip([
    { name: 'doc.kml', data: new TextEncoder().encode(kml) },
  ])
  await writeBinaryFile(path, archive)
  return path
}
