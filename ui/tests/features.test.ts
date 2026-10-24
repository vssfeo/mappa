import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEATURE_COLORS,
  closeRing,
  featureArea,
  featureLength,
  featuresToGeoJSON,
  normalizeDraft,
  parseFeatureGeoJSON,
  type MapFeature,
} from '../src/features.ts'

const line = (coordinates: [number, number][]): MapFeature => ({
  id: 'line-1',
  name: 'Линия',
  kind: 'line',
  coordinates,
  color: FEATURE_COLORS[0],
})

const polygon = (coordinates: [number, number][]): MapFeature => ({
  id: 'polygon-1',
  name: 'Полигон',
  kind: 'polygon',
  coordinates,
  color: FEATURE_COLORS[1],
})

test('GeoJSON import reads lines and opens polygon rings', () => {
  const text = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'Дорога', color: '#3ddc97' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [34.1, 44.5],
            [34.2, 44.6],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { name: 'Район' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [34.0, 44.4],
              [34.5, 44.4],
              [34.5, 44.8],
              [34.0, 44.4],
            ],
          ],
        },
      },
    ],
  })
  const parsed = parseFeatureGeoJSON(text)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].kind, 'line')
  assert.equal(parsed[0].name, 'Дорога')
  assert.equal(parsed[0].color, '#3ddc97')
  assert.equal(parsed[1].kind, 'polygon')
  assert.equal(parsed[1].coordinates.length, 3)
  assert.equal(parsed[1].name, 'Район')
})

test('MultiLineString becomes one feature per line', () => {
  const text = JSON.stringify({
    type: 'Feature',
    properties: { name: 'Тропы' },
    geometry: {
      type: 'MultiLineString',
      coordinates: [
        [
          [34.0, 44.0],
          [34.1, 44.1],
        ],
        [
          [35.0, 45.0],
          [35.1, 45.1],
        ],
      ],
    },
  })
  const parsed = parseFeatureGeoJSON(text)
  assert.equal(parsed.length, 2)
  assert.ok(parsed.every((item) => item.kind === 'line'))
})

test('invalid geometry is skipped', () => {
  const text = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [200, 44],
            [34, 44],
          ],
        },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [34, 44],
            [34.1, 44.1],
          ],
        },
      },
    ],
  })
  const parsed = parseFeatureGeoJSON(text)
  assert.equal(parsed.length, 1)
  assert.deepEqual(parsed[0].coordinates, [
    [34, 44],
    [34.1, 44.1],
  ])
})

test('export closes polygons and round-trips', () => {
  const source = [
    line([
      [34.0, 44.5],
      [34.2, 44.6],
    ]),
    polygon([
      [34.0, 44.4],
      [34.5, 44.4],
      [34.5, 44.8],
    ]),
  ]
  const text = featuresToGeoJSON(source)
  const geojson = JSON.parse(text)
  assert.equal(geojson.features.length, 2)
  assert.deepEqual(geojson.features[1].geometry.coordinates[0][0], [34.0, 44.4])
  assert.deepEqual(geojson.features[1].geometry.coordinates[0].at(-1), [34.0, 44.4])
  const parsed = parseFeatureGeoJSON(text)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[1].coordinates.length, 3)
})

test('closeRing does not duplicate an already closed ring', () => {
  const ring = closeRing([
    [34, 44],
    [35, 44],
    [35, 45],
    [34, 44],
  ])
  assert.equal(ring.length, 4)
})

test('draft normalization drops double-click duplicates', () => {
  const points = normalizeDraft([
    [34, 44],
    [34.1, 44.1],
    [34.1, 44.1],
    [34.2, 44.2],
    [34.2, 44.2],
  ])
  assert.equal(points.length, 3)
})

test('length and area are computed geodesically', () => {
  const measured = line([
    [34, 44],
    [34, 45],
  ])
  assert.ok(featureLength(measured) > 110_000)
  assert.ok(featureLength(measured) < 112_000)

  const square = polygon([
    [34, 44],
    [35, 44],
    [35, 45],
    [34, 45],
  ])
  assert.ok(featureArea(square) > 8_000_000_000)
  assert.ok(featureArea(square) < 9_000_000_000)
})

test('malformed JSON is rejected with a readable error', () => {
  assert.throws(() => parseFeatureGeoJSON('{'), /корректным JSON/)
})

test('one broken entry does not discard valid features', () => {
  const parsed = parseFeatureGeoJSON(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        null,
        { type: 'Feature', geometry: { type: 'LineString', coordinates: null } },
        {
          type: 'Feature',
          properties: { name: 'ok' },
          geometry: {
            type: 'LineString',
            coordinates: [
              [34, 44],
              [35, 45],
            ],
          },
        },
      ],
    }),
  )
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].name, 'ok')
})
