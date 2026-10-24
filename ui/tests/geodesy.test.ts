import assert from 'node:assert/strict'
import test from 'node:test'

import { magneticField } from '../src/geomag.ts'
import { meridianConvergence, pointScaleFactor } from '../src/geodesy.ts'
import { lonLatToUtm } from '../src/geo.ts'

test('convergence is zero on the central meridian', () => {
  const utm = lonLatToUtm(39, 55)
  const central = (utm.zone - 1) * 6 - 180 + 3
  assert.ok(Math.abs(meridianConvergence(central, 55)) < 1e-9)
  const offset = meridianConvergence(central + 2, 55)
  assert.ok(offset > 1 && offset < 2.2, String(offset))
})

test('UTM scale is 0.9996 on the central meridian', () => {
  const utm = lonLatToUtm(39, 55)
  const central = (utm.zone - 1) * 6 - 180 + 3
  assert.ok(Math.abs(pointScaleFactor(central, 55) - 0.9996) < 1e-4)
  assert.ok(pointScaleFactor(central + 3, 55) > 1)
})

test('WMM declination is plausible for European Russia', () => {
  const field = magneticField(37.6173, 55.7558, 0, new Date('2026-01-01'))
  assert.ok(field.declination > 8 && field.declination < 18, String(field.declination))
  assert.ok(field.intensity > 45_000 && field.intensity < 60_000)
  const later = magneticField(37.6173, 55.7558, 0, new Date('2029-01-01'))
  assert.notEqual(later.declination, field.declination)
})
