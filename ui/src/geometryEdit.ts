/**
 * Immutable vertex editing for GeoJSON geometries.
 *
 * Vertex paths address the coordinate tree: `[i]` for Point/MultiPoint and
 * LineString, `[part, i]` for MultiLineString, `[ring, i]` for Polygon and
 * `[polygon, ring, i]` for MultiPolygon. A midpoint path names the vertex
 * that starts the segment; the inserted vertex goes right after it.
 *
 * Polygon rings are stored closed in GeoJSON. Editing works on the open ring
 * and closes it again, so the first and last vertex never drift apart.
 */

import type { Geometry, Position } from 'geojson'

export type VertexPath = number[]

export interface GeometryVertex {
  path: VertexPath
  position: Position
  kind: 'vertex' | 'midpoint'
}

const clone = (position: Position): Position => [position[0], position[1]]

const same = (left: Position, right: Position): boolean =>
  left[0] === right[0] && left[1] === right[1]

const valid = (position: Position): boolean =>
  Number.isFinite(position[0]) &&
  Number.isFinite(position[1]) &&
  position[0] >= -180 &&
  position[0] <= 180 &&
  position[1] >= -90 &&
  position[1] <= 90

const openRing = (ring: Position[]): Position[] => {
  if (ring.length > 2 && same(ring[0], ring[ring.length - 1])) {
    return ring.slice(0, -1).map(clone)
  }
  return ring.map(clone)
}

const closeRing = (ring: Position[]): Position[] => {
  if (ring.length < 3) return ring
  return same(ring[0], ring[ring.length - 1])
    ? ring
    : [...ring, clone(ring[0])]
}

const midpoint = (left: Position, right: Position): Position => [
  (left[0] + right[0]) / 2,
  (left[1] + right[1]) / 2,
]

const lineVertices = (
  coordinates: Position[],
  prefix: VertexPath,
  closed: boolean,
  vertices: GeometryVertex[],
): void => {
  const points = closed ? openRing(coordinates) : coordinates
  points.forEach((position, index) =>
    vertices.push({ path: [...prefix, index], position, kind: 'vertex' }),
  )
  const segments = closed ? points.length : points.length - 1
  for (let index = 0; index < segments; index += 1) {
    const next = points[(index + 1) % points.length]
    if (!next) continue
    vertices.push({
      path: [...prefix, index],
      position: midpoint(points[index], next),
      kind: 'midpoint',
    })
  }
}

/** Lists draggable vertices and insertable segment midpoints. */
export function geometryVertices(geometry: Geometry): GeometryVertex[] {
  const vertices: GeometryVertex[] = []
  switch (geometry.type) {
    case 'Point':
      vertices.push({ path: [0], position: geometry.coordinates, kind: 'vertex' })
      break
    case 'MultiPoint':
      geometry.coordinates.forEach((position, index) =>
        vertices.push({ path: [index], position, kind: 'vertex' }),
      )
      break
    case 'LineString':
      lineVertices(geometry.coordinates, [], false, vertices)
      break
    case 'MultiLineString':
      geometry.coordinates.forEach((line, index) =>
        lineVertices(line, [index], false, vertices),
      )
      break
    case 'Polygon':
      geometry.coordinates.forEach((ring, index) =>
        lineVertices(ring, [index], true, vertices),
      )
      break
    case 'MultiPolygon':
      geometry.coordinates.forEach((polygon, polygonIndex) =>
        polygon.forEach((ring, ringIndex) =>
          lineVertices(ring, [polygonIndex, ringIndex], true, vertices),
        ),
      )
      break
    case 'GeometryCollection':
      break
  }
  return vertices
}

type PointEdit =
  | { kind: 'move'; path: VertexPath; position: Position }
  | { kind: 'insert'; path: VertexPath; position: Position }
  | { kind: 'delete'; path: VertexPath }

function lineEdit(
  coordinates: Position[],
  path: VertexPath,
  edit: PointEdit,
  closed: boolean,
): Position[] | null {
  const points = closed ? openRing(coordinates) : coordinates.map(clone)
  const index = path[0]
  if (!Number.isInteger(index) || index < 0) return null
  if (edit.kind === 'move') {
    if (index >= points.length || !valid(edit.position)) return null
    points[index] = clone(edit.position)
  } else if (edit.kind === 'insert') {
    if (index >= points.length) return null
    if (!valid(edit.position)) return null
    points.splice(index + 1, 0, clone(edit.position))
  } else {
    if (index >= points.length) return null
    points.splice(index, 1)
    // A ring needs three distinct vertices; a line needs two.
    if (points.length < (closed ? 3 : 2)) return null
  }
  return closed ? closeRing(points) : points
}

function editGeometry(geometry: Geometry, edit: PointEdit): Geometry | null {
  const path = edit.path
  switch (geometry.type) {
    case 'Point':
      if (edit.kind !== 'move' || !valid(edit.position)) return null
      return { type: 'Point', coordinates: clone(edit.position) }
    case 'MultiPoint': {
      const coordinates = geometry.coordinates.map(clone)
      const index = path[0]
      if (!Number.isInteger(index) || index < 0 || index >= coordinates.length) {
        return null
      }
      if (edit.kind === 'move') {
        if (!valid(edit.position)) return null
        coordinates[index] = clone(edit.position)
      } else if (edit.kind === 'delete') {
        if (coordinates.length <= 1) return null
        coordinates.splice(index, 1)
      } else {
        return null
      }
      return { type: 'MultiPoint', coordinates }
    }
    case 'LineString': {
      const coordinates = lineEdit(geometry.coordinates, path, edit, false)
      return coordinates ? { type: 'LineString', coordinates } : null
    }
    case 'MultiLineString': {
      const lines = geometry.coordinates.map((line) => line.map(clone))
      const index = path[0]
      if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
        return null
      }
      const coordinates = lineEdit(lines[index], path.slice(1), edit, false)
      if (!coordinates) return null
      lines[index] = coordinates
      return { type: 'MultiLineString', coordinates: lines }
    }
    case 'Polygon': {
      const rings = geometry.coordinates.map((ring) => ring.map(clone))
      const index = path[0]
      if (!Number.isInteger(index) || index < 0 || index >= rings.length) {
        return null
      }
      const coordinates = lineEdit(rings[index], path.slice(1), edit, true)
      if (!coordinates) return null
      rings[index] = coordinates
      return { type: 'Polygon', coordinates: rings }
    }
    case 'MultiPolygon': {
      const polygons = geometry.coordinates.map((polygon) =>
        polygon.map((ring) => ring.map(clone)),
      )
      const polygonIndex = path[0]
      const ringIndex = path[1]
      if (
        !Number.isInteger(polygonIndex) ||
        polygonIndex < 0 ||
        polygonIndex >= polygons.length ||
        !Number.isInteger(ringIndex) ||
        ringIndex < 0 ||
        ringIndex >= polygons[polygonIndex].length
      ) {
        return null
      }
      const coordinates = lineEdit(
        polygons[polygonIndex][ringIndex],
        path.slice(2),
        edit,
        true,
      )
      if (!coordinates) return null
      polygons[polygonIndex][ringIndex] = coordinates
      return { type: 'MultiPolygon', coordinates: polygons }
    }
    default:
      return null
  }
}

/** Moves one existing vertex. Returns null when the path is invalid. */
export function moveGeometryVertex(
  geometry: Geometry,
  path: VertexPath,
  position: Position,
): Geometry | null {
  return editGeometry(geometry, { kind: 'move', path, position })
}

/** Inserts a vertex after the segment start named by `path`. */
export function insertGeometryVertex(
  geometry: Geometry,
  path: VertexPath,
  position: Position,
): Geometry | null {
  return editGeometry(geometry, { kind: 'insert', path, position })
}

/** Deletes a vertex while keeping the geometry drawable. */
export function deleteGeometryVertex(
  geometry: Geometry,
  path: VertexPath,
): Geometry | null {
  return editGeometry(geometry, { kind: 'delete', path })
}
