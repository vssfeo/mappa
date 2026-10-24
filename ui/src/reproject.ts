/**
 * Batch reprojection of imported features through the native proj4 engine.
 *
 * All coordinates are collected first and sent in bounded chunks, so a
 * shapefile with two million vertices costs a handful of IPC calls instead of
 * one per vertex.
 */

import type { Geometry, Position } from 'geojson'
import { transformPoints, type CrsSpec } from './native.ts'
import type { VectorFeature } from './vectorLayers.ts'

const BATCH = 20_000

const eachPosition = (
  geometry: Geometry,
  visit: (position: Position) => void,
): void => {
  switch (geometry.type) {
    case 'Point':
      visit(geometry.coordinates)
      break
    case 'MultiPoint':
    case 'LineString':
      geometry.coordinates.forEach(visit)
      break
    case 'MultiLineString':
    case 'Polygon':
      geometry.coordinates.forEach((line) => line.forEach(visit))
      break
    case 'MultiPolygon':
      geometry.coordinates.forEach((polygon) =>
        polygon.forEach((ring) => ring.forEach(visit)),
      )
      break
    case 'GeometryCollection':
      geometry.geometries.forEach((item) => eachPosition(item, visit))
      break
  }
}

const rebuild = (
  geometry: Geometry,
  next: () => Position | null,
): Geometry | null => {
  const position = (): Position | null => {
    const value = next()
    if (
      !value ||
      !Number.isFinite(value[0]) ||
      !Number.isFinite(value[1]) ||
      value[0] < -180 ||
      value[0] > 180 ||
      value[1] < -90 ||
      value[1] > 90
    ) {
      return null
    }
    return [value[0], value[1]]
  }
  const positions = (
    original: Position[],
    transform: (index: number) => Position | null,
  ): Position[] | null => {
    const result: Position[] = []
    for (let index = 0; index < original.length; index += 1) {
      const value = transform(index)
      if (!value) return null
      result.push(value)
    }
    return result
  }

  switch (geometry.type) {
    case 'Point': {
      const value = position()
      return value ? { type: 'Point', coordinates: value } : null
    }
    case 'MultiPoint':
    case 'LineString': {
      const coordinates = positions(geometry.coordinates, () => position())
      if (!coordinates) return null
      return geometry.type === 'MultiPoint'
        ? { type: 'MultiPoint', coordinates }
        : { type: 'LineString', coordinates }
    }
    case 'MultiLineString': {
      const coordinates: Position[][] = []
      for (const original of geometry.coordinates) {
        const transformed = positions(original, () => position())
        if (!transformed) return null
        coordinates.push(transformed)
      }
      return { type: 'MultiLineString', coordinates }
    }
    case 'Polygon': {
      const coordinates: Position[][] = []
      for (const original of geometry.coordinates) {
        const transformed = positions(original, () => position())
        if (!transformed) return null
        coordinates.push(transformed)
      }
      return { type: 'Polygon', coordinates }
    }
    case 'MultiPolygon': {
      const coordinates: Position[][][] = []
      for (const polygon of geometry.coordinates) {
        const rings: Position[][] = []
        for (const original of polygon) {
          const transformed = positions(original, () => position())
          if (!transformed) return null
          rings.push(transformed)
        }
        coordinates.push(rings)
      }
      return { type: 'MultiPolygon', coordinates }
    }
    case 'GeometryCollection': {
      const geometries: Geometry[] = []
      for (const item of geometry.geometries) {
        const transformed = rebuild(item, next)
        if (!transformed) return null
        geometries.push(transformed)
      }
      return { type: 'GeometryCollection', geometries }
    }
  }
}

/**
 * Converts every coordinate from `from` to WGS84. Features that contain a
 * vertex outside the valid longitude/latitude range are dropped.
 */
export async function reprojectFeatures(
  features: VectorFeature[],
  from: CrsSpec,
): Promise<{ features: VectorFeature[]; skipped: number }> {
  const usable: VectorFeature[] = []
  let skipped = 0
  for (const feature of features) {
    let valid = true
    eachPosition(feature.geometry, (position) => {
      if (!Number.isFinite(position[0]) || !Number.isFinite(position[1])) {
        valid = false
      }
    })
    if (valid) usable.push(feature)
    else skipped += 1
  }

  const points: [number, number][] = []
  for (const feature of usable) {
    eachPosition(feature.geometry, (position) => {
      points.push([position[0], position[1]])
    })
  }
  if (points.length === 0) return { features: [], skipped: features.length }

  const transformed: [number, number][] = []
  for (let index = 0; index < points.length; index += BATCH) {
    const chunk = points.slice(index, index + BATCH)
    const result = await transformPoints(from, { epsg: 4326 }, chunk)
    transformed.push(...result)
  }

  let cursor = 0
  const next = (): Position | null => {
    const value = transformed[cursor]
    cursor += 1
    return value ?? null
  }
  const result: VectorFeature[] = []
  for (const feature of usable) {
    const geometry = rebuild(feature.geometry, next)
    if (geometry) {
      result.push({ ...feature, geometry })
    } else {
      skipped += 1
    }
  }
  return { features: result, skipped }
}
