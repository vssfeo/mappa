import assert from 'node:assert/strict'
import test from 'node:test'
import type { Geometry, Polygon } from 'geojson'

import {
  deleteGeometryVertex,
  geometryVertices,
  insertGeometryVertex,
  moveGeometryVertex,
} from '../src/geometryEdit.ts'

test('moves, inserts and deletes line vertices', () => {
  const line: Geometry = {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [1, 0],
      [2, 0],
    ],
  }
  const moved = moveGeometryVertex(line, [1], [1, 1])
  assert.deepEqual(moved, {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [1, 1],
      [2, 0],
    ],
  })
  const inserted = insertGeometryVertex(line, [0], [0.5, 0.2])
  assert.deepEqual((inserted as Geometry & { coordinates: number[][] }).coordinates, [
    [0, 0],
    [0.5, 0.2],
    [1, 0],
    [2, 0],
  ])
  assert.equal(deleteGeometryVertex(line, [1]) !== null, true)
  const shortened = deleteGeometryVertex(line, [2])
  assert.equal(shortened?.type, 'LineString')
  if (shortened?.type === 'LineString') {
    assert.equal(shortened.coordinates.length, 2)
  }
  assert.equal(
    deleteGeometryVertex(
      { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
      [0],
    ),
    null,
  )
})

test('keeps polygon rings closed while editing', () => {
  const polygon: Geometry = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [0, 0],
      ],
    ],
  }
  const moved = moveGeometryVertex(polygon, [0, 0], [0.5, 0.5]) as Polygon
  assert.deepEqual(moved.coordinates[0][0], [0.5, 0.5])
  assert.deepEqual(moved.coordinates[0].at(-1), [0.5, 0.5])
  const inserted = insertGeometryVertex(polygon, [0, 3], [0, 1]) as Polygon
  assert.equal(inserted.coordinates[0].length, 6)
  assert.deepEqual(inserted.coordinates[0].at(-1), inserted.coordinates[0][0])
  assert.equal(
    deleteGeometryVertex(
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      [0, 1],
    ),
    null,
  )
})

test('lists vertices and segment midpoints', () => {
  const vertices = geometryVertices({
    type: 'MultiLineString',
    coordinates: [
      [
        [0, 0],
        [2, 0],
      ],
      [
        [5, 5],
        [5, 7],
      ],
    ],
  })
  assert.equal(vertices.filter((item) => item.kind === 'vertex').length, 4)
  assert.equal(vertices.filter((item) => item.kind === 'midpoint').length, 2)
  assert.deepEqual(
    vertices.find((item) => item.kind === 'midpoint' && item.path[0] === 0)
      ?.position,
    [1, 0],
  )
})

test('edits multipolygon vertices by path', () => {
  const multi: Geometry = {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
      [
        [
          [10, 10],
          [11, 10],
          [11, 11],
          [10, 10],
        ],
      ],
    ],
  }
  const moved = moveGeometryVertex(multi, [1, 0, 1], [12, 10])
  assert.equal(moved?.type, 'MultiPolygon')
  if (moved?.type === 'MultiPolygon') {
    assert.deepEqual(moved.coordinates[1][0][1], [12, 10])
  }
})
