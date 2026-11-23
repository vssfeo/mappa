import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMeraGeoJsonTrack } from '../src/mera.ts'

test('parseMeraGeoJsonTrack splits FIXED and FLOAT segments with continuous junctions', () => {
  const geojson = JSON.stringify({
    type: 'FeatureCollection',
    properties: { causalityMode: 'causal' },
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [139.79, 35.66, 39.5] },
        properties: { quality: 'FIXED', fixQuality: 4 },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [139.791, 35.661, 39.6] },
        properties: { quality: 'FIXED', fixQuality: 4 },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [139.792, 35.662, 39.7] },
        properties: { quality: 'FLOAT', fixQuality: 5 },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [139.793, 35.663, 39.8] },
        properties: { quality: 'FLOAT', fixQuality: 5 },
      },
    ],
  })

  const parsed = parseMeraGeoJsonTrack(geojson)
  assert.equal(parsed.points, 4)
  assert.equal(parsed.fixedPoints, 2)
  assert.equal(parsed.allCoordinates.length, 4)
  assert.equal(parsed.segments.length, 2)
  assert.equal(parsed.segments[0]?.quality, 'FIXED')
  assert.deepEqual(parsed.segments[0]?.coordinates, [
    [139.79, 35.66],
    [139.791, 35.661],
  ])
  assert.equal(parsed.segments[1]?.quality, 'FLOAT')
  // Junction vertex [139.791, 35.661] is shared so there is no gap between segments.
  assert.deepEqual(parsed.segments[1]?.coordinates, [
    [139.791, 35.661],
    [139.792, 35.662],
    [139.793, 35.663],
  ])
  assert.ok(parsed.center !== null)
  assert.ok(Math.abs(parsed.center[0] - 139.7915) < 1e-9)
  assert.ok(Math.abs(parsed.center[1] - 35.6615) < 1e-9)
})
