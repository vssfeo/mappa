import assert from 'node:assert/strict'
import test from 'node:test'

import { distance } from '../src/geo.ts'
import { lonLatToMgrs, mgrsToLonLat } from '../src/mgrs.ts'

test('formats MGRS with zone, band and 100 km square', () => {
  const value = lonLatToMgrs(37.6173, 55.7558)
  assert.ok(value)
  assert.match(value ?? '', /^37U [A-HJ-NP-Z]{2} \d{5} \d{5}$/)
  const back = mgrsToLonLat(value ?? '')
  assert.ok(back)
  assert.ok(distance([37.6173, 55.7558], back) < 2, String(back))
})

test('round-trips MGRS across hemispheres', () => {
  const samples: [number, number][] = [
    [34.1, 44.95],
    [-0.1276, 51.5072],
    [151.2093, -33.8688],
    [-104.9903, 39.7392],
    [18.4241, -33.9249],
    [37.6, 0.1],
  ]
  for (const point of samples) {
    const mgrs = lonLatToMgrs(point[0], point[1])
    assert.ok(mgrs, `${point}`)
    const back = mgrsToLonLat(mgrs)
    assert.ok(back, mgrs)
    assert.ok(
      distance(point, back) < 2,
      `${mgrs}: ${point} -> ${back} (${distance(point, back)} m)`,
    )
  }
})

test('rejects malformed MGRS and out-of-band coordinates', () => {
  assert.equal(mgrsToLonLat('37U DB 123'), null)
  assert.equal(mgrsToLonLat('99U DB 12345 67890'), null)
  assert.equal(mgrsToLonLat('37U IA 12345 67890'), null)
  assert.equal(lonLatToMgrs(0, 89), null)
})
