/** Latitude/longitude graticule geometry for the map overlay. */

import type { Bounds } from './format.ts'

const MAX_LINES_PER_AXIS = 120
const MERCATOR_LIMIT = 85.051_128_78

export function gridStep(zoom: number): number {
  if (zoom < 3) return 30
  if (zoom < 5) return 10
  if (zoom < 7) return 5
  if (zoom < 9) return 2
  if (zoom < 11) return 1
  if (zoom < 13) return 0.5
  if (zoom < 15) return 0.2
  return 0.1
}

const values = (
  from: number,
  to: number,
  step: number,
): number[] => {
  const result: number[] = []
  const start = Math.ceil(from / step) * step
  for (let value = start; value <= to + 1e-9; value += step) {
    if (result.length >= MAX_LINES_PER_AXIS) break
    result.push(Math.abs(value) < 1e-9 ? 0 : value)
  }
  return result
}

export interface Graticule {
  lines: {
    value: number
    axis: 'lon' | 'lat'
    coordinates: [number, number][]
  }[]
  lons: number[]
  lats: number[]
}

/** Builds a bounded graticule clipped to the Mercator world. */
export function graticule(bounds: Bounds, zoom: number): Graticule {
  const [[west, south], [east, north]] = bounds
  let step = gridStep(zoom)
  let lons = values(Math.max(-180, west), Math.min(180, east), step)
  let lats = values(
    Math.max(-MERCATOR_LIMIT, south),
    Math.min(MERCATOR_LIMIT, north),
    step,
  )
  // A world view can exceed the line budget; coarsen instead of truncating
  // asymmetrically (which would look like the grid vanished on one side).
  while (lons.length > MAX_LINES_PER_AXIS || lats.length > MAX_LINES_PER_AXIS) {
    step *= 2
    lons = values(Math.max(-180, west), Math.min(180, east), step)
    lats = values(
      Math.max(-MERCATOR_LIMIT, south),
      Math.min(MERCATOR_LIMIT, north),
      step,
    )
  }
  const latSouth = Math.max(-MERCATOR_LIMIT, south)
  const latNorth = Math.min(MERCATOR_LIMIT, north)
  const lines: Graticule['lines'] = []
  for (const lon of lons) {
    lines.push({
      value: lon,
      axis: 'lon',
      coordinates: [
        [lon, latSouth],
        [lon, latNorth],
      ],
    })
  }
  for (const lat of lats) {
    lines.push({
      value: lat,
      axis: 'lat',
      coordinates: [
        [Math.max(-180, west), lat],
        [Math.min(180, east), lat],
      ],
    })
  }
  return { lines, lons, lats }
}

export function gridLabel(value: number, axis: 'lon' | 'lat'): string {
  const suffix = axis === 'lon' ? (value < 0 ? 'W' : 'E') : value < 0 ? 'S' : 'N'
  const absolute = Math.abs(value)
  const text = Number.isInteger(absolute)
    ? String(absolute)
    : absolute.toFixed(1)
  return `${text}°${suffix}`
}
