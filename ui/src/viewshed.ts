/** Radio line of sight, Fresnel zone and terrain viewshed. */

import { invoke } from '@tauri-apps/api/core'
import { isNative } from './native'

export interface LosPoint {
  distanceM: number
  terrainM: number
  losM: number
  fresnelM: number
  clearanceM: number
}

export interface LosReport {
  points: LosPoint[]
  distanceM: number
  blocked: boolean
  minClearanceM: number
  fresnelFraction: number
  frequencyGhz: number
}

export interface ViewshedResult {
  polygon: [number, number][]
  areaKm2: number
  maxDistanceM: number
  rays: number
}

export const computeLos = async (
  from: [number, number],
  to: [number, number],
  observerHeight: number,
  targetHeight: number,
  frequencyGhz: number,
): Promise<LosReport> => {
  if (!isNative) throw new Error('terrain analysis is available in the desktop app')
  return invoke<LosReport>('los_compute', {
    from,
    to,
    observerHeight,
    targetHeight,
    frequencyGhz,
  })
}

export const computeViewshed = async (
  center: [number, number],
  radiusM: number,
  observerHeight: number,
  rays = 720,
): Promise<ViewshedResult> => {
  if (!isNative) throw new Error('terrain analysis is available in the desktop app')
  return invoke<ViewshedResult>('viewshed_compute', {
    center,
    radiusM,
    observerHeight,
    rays,
  })
}
