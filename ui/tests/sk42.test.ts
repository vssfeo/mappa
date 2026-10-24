import assert from 'node:assert/strict'
import test from 'node:test'

import { sk42Epsg, sk42Zone, sk42ZoneFromY } from '../src/sk42.ts'

test('SK-42 zone follows the 6-degree longitude belt', () => {
  assert.equal(sk42Zone(37.6173), 7)
  assert.equal(sk42Zone(30.3159), 6)
  assert.equal(sk42Zone(12), 3)
  assert.equal(sk42Zone(179.9), 30)
  assert.equal(sk42Zone(11.9), null)
  assert.equal(sk42Zone(-75), null)
  assert.equal(sk42Zone(181), null)
})

test('SK-42 easting prefix identifies the zone', () => {
  assert.equal(sk42ZoneFromY(7_413_187.97), 7)
  assert.equal(sk42ZoneFromY(12_345_678.9), 12)
  assert.equal(sk42ZoneFromY(413_187.97), null)
  assert.equal(sk42ZoneFromY(0), null)
  assert.equal(sk42Epsg(7), 28407)
  assert.equal(sk42Epsg(32), 28432)
})
