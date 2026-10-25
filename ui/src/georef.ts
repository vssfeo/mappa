/** Ground control points and scan georeferencing. */

import { invoke } from '@tauri-apps/api/core'
import { isNative } from './native'

export type GeorefModel = 'affine' | 'helmert'

export interface Gcp {
  px: number
  py: number
  lon: number
  lat: number
}

export interface Affine {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export interface GeorefSolution {
  affine: Affine
  /** Root mean square error in metres. */
  rmse: number
  residuals: number[]
  /** EPSG:3857: west, south, east, north. */
  bounds: [number, number, number, number]
}

export interface WarpReport {
  solution: GeorefSolution
  width: number
  height: number
  resolution: number
}

export const solveGeoref = async (
  gcps: Gcp[],
  width: number,
  height: number,
  model: GeorefModel = 'affine',
): Promise<GeorefSolution> => {
  if (!isNative) throw new Error('georeferencing is available in the desktop app')
  return invoke<GeorefSolution>('georef_solve', { gcps, width, height, model })
}

export const warpScan = async (
  input: string,
  output: string,
  gcps: Gcp[],
  model: GeorefModel = 'affine',
  resolution: number | null = null,
): Promise<WarpReport> => {
  if (!isNative) throw new Error('georeferencing is available in the desktop app')
  return invoke<WarpReport>('georef_warp', { input, output, gcps, model, resolution })
}
