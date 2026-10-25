import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { isNative } from './native.ts'
import { useAppStore } from './store.ts'
import { tr } from './locale.ts'

export interface DemInfo {
  id: string
  name: string
  path: string
  format: 'hgt' | 'asc' | 'tif'
  west: number
  south: number
  east: number
  north: number
  ncols: number
  nrows: number
  cellSize: number
  resolutionMeters: number
  minElevation: number
  maxElevation: number
  maxZoom: number
}

export interface DemSample {
  id: string
  elevation: number
  slope: number
  aspect: number
}

export interface ContourLine {
  level: number
  coordinates: [number, number][]
}

export interface ContourResult {
  interval: number
  levels: number
  lines: ContourLine[]
  points: number
  truncated: boolean
}

/** Loads a DEM by absolute path and makes it the active terrain source. */
export async function openDemPath(path: string): Promise<DemInfo> {
  if (!isNative) {
    throw new Error(
      tr(
        'DEM доступен в нативном приложении',
        'DEM is available in the native app',
      ),
    )
  }
  const info = await invoke<DemInfo>('open_dem', { path })
  useAppStore.getState().setDem(info)
  return info
}

/** File picker for SRTM `.hgt`, ESRI ASCII `.asc` and GeoTIFF/COG. */
export async function importDem(): Promise<DemInfo | null> {
  if (!isNative) {
    throw new Error(
      tr(
        'DEM доступен в нативном приложении',
        'DEM is available in the native app',
      ),
    )
  }
  const selected = await open({
    multiple: false,
    directory: false,
    title: tr('Открыть высоты рельефа', 'Open an elevation model'),
    filters: [
      {
        name: tr('Цифровая модель высот', 'Digital elevation model'),
        extensions: ['hgt', 'asc', 'tif', 'tiff'],
      },
    ],
  })
  const path = Array.isArray(selected) ? selected[0] : selected
  if (typeof path !== 'string' || path.length === 0) return null
  return openDemPath(path)
}

/** Closes the backend model, then clears the map layer. */
export async function closeDem(id: string): Promise<void> {
  try {
    if (isNative) await invoke('close_dem', { id })
  } finally {
    useAppStore.getState().forgetDem()
  }
}

let restoring = false

/** Reopens the DEM remembered from the last session. */
export async function restoreDem(): Promise<void> {
  const path = useAppStore.getState().demPath
  if (!isNative || !path || restoring) return
  restoring = true
  try {
    await openDemPath(path)
  } catch (error) {
    console.warn('cannot restore DEM', path, error)
    useAppStore.getState().forgetDem()
  } finally {
    restoring = false
  }
}

/** Elevation, slope and aspect under a WGS84 point. */
export async function demSample(
  lon: number,
  lat: number,
): Promise<DemSample | null> {
  if (!isNative) return null
  return invoke<DemSample | null>('dem_sample', { lon, lat })
}

/** Terrain elevations aligned with the supplied line vertices. */
export async function demProfile(
  points: [number, number][],
): Promise<(number | null)[]> {
  if (!isNative) {
    throw new Error(
      tr('DEM доступен в нативном приложении', 'DEM is available in the native app'),
    )
  }
  return invoke<(number | null)[]>('dem_profile', { points })
}

/** Marching-squares contours from the active DEM. */
export async function demContours(
  interval: number,
  step: number,
): Promise<ContourResult> {
  if (!isNative) {
    throw new Error(
      tr('DEM доступен в нативном приложении', 'DEM is available in the native app'),
    )
  }
  return invoke<ContourResult>('dem_contours', { interval, step })
}
