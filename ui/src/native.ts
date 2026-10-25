import { invoke } from '@tauri-apps/api/core'
import { addProtocol } from 'maplibre-gl'
import { tr } from './locale.ts'

/**
 * True when the UI is running inside the Tauri WebView rather than a plain
 * browser tab. The browser build talks to providers directly; the native
 * build routes every tile through the Rust cache.
 */
export const isNative =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export interface NativeCacheStats {
  tiles: number
  bytes: number
  hits: number
  misses: number
}

export interface NativeSettings {
  cacheLimitBytes: number
  proxy: string | null
  geocodeOnline: boolean
  crashReports: boolean
}

export interface NativeProvider {
  id: string
  name: string
  kind: string
  minZoom: number
  maxZoom: number
  tileSize: number
  format: string
  attribution: string
  terms: string | null
}

const TILE_PREFIX = 'mappa://tiles/'
const PACK_PREFIX = 'mappa://pack/'
const DEM_PREFIX = 'mappa://dem/'

let registered = false
let nextRequestId = 1

/** Installs the `mappa://` tile and pack handlers once. */
export function registerNativeTileProtocol() {
  if (!isNative || registered) return
  registered = true
  addProtocol('mappa', async (params, abortController) => {
    if (abortController.signal.aborted) {
      throw new DOMException('Tile request aborted', 'AbortError')
    }
    let raw: ArrayBuffer | Uint8Array
    if (params.url.startsWith(TILE_PREFIX)) {
      const [providerId, z, x, y] = parseParts(params.url, TILE_PREFIX)
      if (!providerId) throw malformed(params.url)
      // Tell Rust to drop the HTTP future when the viewport moves on;
      // otherwise abandoned tiles keep consuming the provider budget.
      const requestId = nextRequestId++
      const cancel = () => {
        void invoke('cancel_tile', { requestId }).catch(() => {})
      }
      abortController.signal.addEventListener('abort', cancel, { once: true })
      try {
        raw = await invoke<ArrayBuffer | Uint8Array>('read_tile', {
          providerId,
          z: Number(z),
          x: Number(x),
          y: Number(y),
          requestId,
        })
      } finally {
        abortController.signal.removeEventListener('abort', cancel)
      }
    } else if (params.url.startsWith(PACK_PREFIX)) {
      const [packId, z, x, y] = parseParts(params.url, PACK_PREFIX)
      if (!packId) throw malformed(params.url)
      raw = await invoke<ArrayBuffer | Uint8Array>('read_pack_tile', {
        packId,
        z: Number(z),
        x: Number(x),
        y: Number(y),
      })
    } else if (params.url.startsWith(DEM_PREFIX)) {
      const [demId, z, x, y] = parseParts(params.url, DEM_PREFIX)
      if (!demId) throw malformed(params.url)
      raw = await invoke<ArrayBuffer | Uint8Array>('read_dem_tile', {
        id: demId,
        z: Number(z),
        x: Number(x),
        y: Number(y),
      })
    } else {
      throw new Error(`unsupported native tile URL: ${params.url}`)
    }
    if (abortController.signal.aborted) {
      throw new DOMException('Tile request aborted', 'AbortError')
    }
    return { data: toArrayBuffer(raw) }
  })
}

function parseParts(url: string, prefix: string) {
  return url
    .slice(prefix.length)
    .split('/')
    .map((part) => decodeURIComponent(part))
}

function malformed(url: string) {
  return new Error(`malformed native tile URL: ${url}`)
}

/** Tile template per provider: native cache protocol or direct HTTP. */
export function providerTiles(providerId: string, direct: string[]): string[] {
  return isNative
    ? [`${TILE_PREFIX}${providerId}/{z}/{x}/{y}`]
    : direct
}

export async function cacheStats(): Promise<NativeCacheStats | null> {
  if (!isNative) return null
  try {
    return await invoke<NativeCacheStats>('cache_stats')
  } catch (error) {
    console.warn('cache_stats failed', error)
    return null
  }
}

export interface CoverageResponse {
  tiles: [number, number, number][]
  truncated: boolean
}

/** Cached tiles intersecting a viewport at one zoom. */
export async function coverageTiles(
  providerId: string,
  z: number,
  west: number,
  south: number,
  east: number,
  north: number,
): Promise<CoverageResponse> {
  return invoke<CoverageResponse>('coverage_tiles', {
    providerId,
    z,
    west,
    south,
    east,
    north,
  })
}

export interface ProviderCacheStats {
  providerId: string
  tiles: number
  bytes: number
}

/** Cache usage grouped by source. */
export async function cacheStatsByProvider(): Promise<ProviderCacheStats[]> {
  if (!isNative) return []
  try {
    return await invoke<ProviderCacheStats[]>('cache_stats_by_provider')
  } catch (error) {
    console.warn('cache_stats_by_provider failed', error)
    return []
  }
}

export async function cachePath(): Promise<string | null> {
  if (!isNative) return null
  try {
    return await invoke<string>('cache_path')
  } catch (error) {
    console.warn('cache_path failed', error)
    return null
  }
}

export async function getSettings(): Promise<NativeSettings | null> {
  if (!isNative) return null
  try {
    return await invoke<NativeSettings>('get_settings')
  } catch (error) {
    console.warn('get_settings failed', error)
    return null
  }
}

export async function updateSettings(
  settings: NativeSettings,
): Promise<NativeSettings> {
  return invoke<NativeSettings>('update_settings', { settings })
}

export interface CrsSpec {
  epsg?: number | null
  proj?: string | null
}

export interface CrsPreset {
  epsg: number
  label: string
  units: string
  geographic: boolean
}

export async function crsPresets(): Promise<CrsPreset[]> {
  if (!isNative) return []
  try {
    return await invoke<CrsPreset[]>('crs_presets')
  } catch (error) {
    console.warn('crs_presets failed', error)
    return []
  }
}

export async function transformPoints(
  from: CrsSpec,
  to: CrsSpec,
  points: [number, number][],
): Promise<[number, number][]> {
  return invoke<[number, number][]>('transform_points', { from, to, points })
}

export interface XyzImport {
  path: string
  name: string
  tiles: number
  skipped: number
  minZoom: number
  maxZoom: number
  west: number
  south: number
  east: number
  north: number
  format: string
}

/** Packs a `<z>/<x>/<y>` tile folder into MBTiles in app data. */
export async function importXyzFolder(
  path: string,
  name?: string,
  license?: string,
): Promise<XyzImport> {
  return invoke<XyzImport>('import_xyz_folder', {
    path,
    name: name ?? null,
    license: license ?? null,
  })
}

export interface CacheIntegrity {
  checked: number
  corrupt: number
  removed: number
  bytes: number
  examples: string[]
}

/** Verifies cached image blobs; optionally removes damaged tiles. */
export async function verifyCache(
  repair: boolean,
  providerId?: string,
): Promise<CacheIntegrity> {
  return invoke<CacheIntegrity>('verify_cache', {
    repair,
    providerId: providerId ?? null,
  })
}

/** Recovery project path in the application data directory. */
export async function autosavePath(): Promise<string> {
  if (!isNative) throw new Error(tr('Автосохранение доступно в приложении', 'Autosave is available in the app'))
  return invoke<string>('autosave_path')
}

/** Opens the log directory and returns its path. */
export async function openLogDirectory(): Promise<string> {
  return invoke<string>('open_log_directory')
}

export async function clearCache(
  providerId: string | null = null,
): Promise<number> {
  return invoke<number>('clear_cache', { providerId })
}

export interface WmtsLayer {
  identifier: string
  title: string
  style: string
  format: string
  matrixSet: string
  url: string
  minZoom: number
  maxZoom: number
  tileSize: number
  bounds: [number, number, number, number] | null
}

export interface GeoPackageImport {
  name: string
  srs: string
  features: unknown[]
  skipped: number
  truncated: boolean
}

export interface GeoPackageLayer {
  name: string
  srs: string
  geometryType: string
  features: number
}

/** Lists feature tables in a GeoPackage through SQLite. */
export async function listGeoPackageLayers(
  path: string,
): Promise<GeoPackageLayer[]> {
  if (!isNative) {
    throw new Error(tr('GeoPackage доступен в нативном приложении', 'GeoPackage is available in the native app'))
  }
  return invoke<GeoPackageLayer[]>('list_geopackage_layers', { path })
}

/** Reads one feature layer (the first by default) from a GeoPackage. */
export async function importGeoPackage(
  path: string,
  layer?: string,
): Promise<GeoPackageImport> {
  if (!isNative) {
    throw new Error(tr('GeoPackage доступен в нативном приложении', 'GeoPackage is available in the native app'))
  }
  return invoke<GeoPackageImport>('import_geopackage', {
    path,
    layer: layer ?? null,
  })
}

export interface WmtsCapabilities {
  title: string
  layers: WmtsLayer[]
}

/** Reads a WMTS GetCapabilities document through the native HTTP client. */
export async function wmtsCapabilities(
  url: string,
  headers: Record<string, string> = {},
  sourceId?: string,
): Promise<WmtsCapabilities> {
  if (!isNative) {
    throw new Error(tr('WMTS доступен в нативном приложении', 'WMTS is available in the native app'))
  }
  return invoke<WmtsCapabilities>('wmts_capabilities', {
    url,
    headers,
    sourceId: sourceId ?? null,
  })
}

export async function readTextFile(path: string): Promise<string> {
  return invoke<string>('read_text_file', { path })
}

/** Reads a binary user document (KMZ, SHP, GeoPackage) without base64. */
export async function readBinaryFile(path: string): Promise<ArrayBuffer> {
  return toArrayBuffer(
    await invoke<ArrayBuffer | Uint8Array>('read_binary_file', { path }),
  )
}

/** Writes an exported document (PNG, PDF, world file) atomically. */
export async function writeBinaryFile(
  path: string,
  data: ArrayBuffer | Uint8Array,
): Promise<void> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  await invoke('write_binary_file', { path, data: Array.from(bytes) })
}

export interface GeoTiffGeoreference {
  west: number
  north: number
  resX: number
  resY: number
}

/** Embeds a map PNG into a GeoTIFF (EPSG:3857) in the native backend. */
export async function exportGeoTiff(
  path: string,
  png: ArrayBuffer | Uint8Array,
  geo: GeoTiffGeoreference,
): Promise<void> {
  const bytes = png instanceof Uint8Array ? png : new Uint8Array(png)
  await invoke('export_geotiff', {
    path,
    png: Array.from(bytes),
    west: geo.west,
    north: geo.north,
    resX: geo.resX,
    resY: geo.resY,
  })
}

export async function writeTextFile(
  path: string,
  contents: string,
): Promise<void> {
  await invoke('write_text_file', { path, contents })
}

export async function listProviders(): Promise<NativeProvider[] | null> {
  if (!isNative) return null
  try {
    return await invoke<NativeProvider[]>('list_providers')
  } catch (error) {
    console.warn('list_providers failed', error)
    return null
  }
}

function toArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer
  }
  // Defensive: older IPC paths may hand back a plain byte array.
  return Uint8Array.from(value as unknown as number[]).buffer
}
