import assert from 'node:assert/strict'
import test from 'node:test'

import { GpsdParser } from '../src/gpsd.ts'

const line = (value: object) => JSON.stringify(value)

test('gpsd TPV and SKY become a fix', () => {
  const parser = new GpsdParser()
  assert.equal(
    parser.push(
      line({
        class: 'SKY',
        hdop: 0.9,
        uSat: 11,
        satellites: [{ used: true }],
      }),
    ),
    null,
  )
  const fix = parser.push(
    line({
      class: 'TPV',
      mode: 3,
      time: '2026-10-25T12:34:56.000Z',
      lat: 55.75,
      lon: 37.61,
      altMSL: 160.5,
      speed: 5.2,
      track: 91.5,
      epx: 1.2,
      epy: 0.8,
    }),
  )
  assert.ok(fix)
  assert.equal(fix.source, 'gpsd')
  assert.equal(fix.lat, 55.75)
  assert.equal(fix.lon, 37.61)
  assert.equal(fix.altitude, 160.5)
  assert.equal(fix.speed, 5.2)
  assert.equal(fix.heading, 91.5)
  assert.equal(fix.satellites, 11)
  assert.equal(fix.hdop, 0.9)
  assert.equal(fix.timestamp, Date.parse('2026-10-25T12:34:56.000Z'))
  assert.ok(Math.abs(fix.accuracy - Math.hypot(1.2, 0.8)) < 1e-9)
})

test('gpsd ignores reports without a 2D/3D fix', () => {
  const parser = new GpsdParser()
  assert.equal(parser.push('not json'), null)
  assert.equal(parser.push(line({ class: 'VERSION', release: '3.25' })), null)
  assert.equal(
    parser.push(line({ class: 'TPV', mode: 1, lat: 55.75, lon: 37.61 })),
    null,
  )
})

test('gpsd falls back to altHAE and counts used satellites', () => {
  const parser = new GpsdParser()
  parser.push(
    line({
      class: 'SKY',
      hdop: 1.4,
      satellites: [
        { used: true },
        { used: false },
        { used: true },
      ],
    }),
  )
  const fix = parser.push(
    line({
      class: 'TPV',
      mode: 2,
      lat: 55.75,
      lon: 37.61,
      altHAE: 155,
    }),
  )
  assert.ok(fix)
  assert.equal(fix.altitude, 155)
  assert.equal(fix.satellites, 2)
  assert.equal(fix.accuracy, 10)
  assert.equal(fix.speed, null)
  assert.equal(fix.heading, null)
})
