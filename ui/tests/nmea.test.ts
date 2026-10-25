import assert from 'node:assert/strict'
import test from 'node:test'

import { distance } from '../src/geo.ts'
import {
  NMEA_KNOTS_TO_MPS,
  NmeaParser,
  NmeaSimulator,
  formatNmea,
  nmeaChecksum,
} from '../src/nmea.ts'

const GGA =
  '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47'
const RMC =
  '$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A'

test('parses a GGA fix with checksum, altitude and HDOP', () => {
  const parser = new NmeaParser()
  assert.equal(parser.push(GGA), true)
  const fix = parser.fix()
  assert.ok(fix)
  assert.equal(fix.source, 'nmea')
  assert.ok(Math.abs(fix.lat - 48.1173) < 1e-7)
  assert.ok(Math.abs(fix.lon - 11.5166666667) < 1e-7)
  assert.equal(fix.altitude, 545.4)
  assert.equal(fix.satellites, 8)
  assert.equal(fix.hdop, 0.9)
  assert.equal(fix.quality, 1)
  assert.ok(Math.abs(fix.accuracy - 4.5) < 1e-9)
  assert.equal(fix.speed, null)
  assert.equal(fix.heading, null)
})

test('parses RMC date, speed and course', () => {
  const parser = new NmeaParser()
  assert.equal(parser.push(RMC), true)
  const fix = parser.fix()
  assert.ok(fix)
  assert.equal(fix.timestamp, Date.UTC(1994, 2, 23, 12, 35, 19))
  assert.ok(Math.abs((fix.speed ?? 0) - 22.4 * NMEA_KNOTS_TO_MPS) < 1e-9)
  assert.ok(Math.abs((fix.heading ?? 0) - 84.4) < 1e-9)
})

test('rejects a bad checksum and accepts a sentence without one', () => {
  const parser = new NmeaParser()
  assert.equal(parser.push(GGA.replace(/\*47$/, '*00')), false)
  assert.equal(parser.fix(), null)
  assert.equal(parser.push(GGA.replace(/\*47$/, '')), true)
  assert.ok(parser.fix())
})

test('decodes southern and western hemispheres', () => {
  const body =
    'GPGGA,123519,4807.038,S,01131.000,W,1,08,0.9,545.4,M,46.9,M,,'
  const parser = new NmeaParser()
  assert.equal(parser.push(formatNmea(body)), true)
  const fix = parser.fix()
  assert.ok(fix)
  assert.ok(fix.lat < 0)
  assert.ok(fix.lon < 0)
})

test('simulator emits a complete valid NMEA cycle and moves', () => {
  const start: [number, number] = [37.6173, 55.7558]
  const simulator = new NmeaSimulator(start, 5)
  const first = simulator.step(Date.UTC(2026, 9, 24, 12, 0, 0))
  assert.equal(first.sentences.length, 4)
  for (const sentence of first.sentences) {
    assert.match(sentence, /^\$GP/)
    const star = sentence.lastIndexOf('*')
    assert.equal(
      Number.parseInt(sentence.slice(star + 1), 16),
      nmeaChecksum(sentence.slice(1, star)),
    )
  }
  assert.ok(first.fix)
  assert.equal(first.fix.source, 'nmea')
  assert.equal(first.fix.satellites, 12)
  assert.ok((first.fix.speed ?? 0) > 4.9)
  assert.equal(first.fix.timestamp, Date.UTC(2026, 9, 24, 12, 0, 0))

  const second = simulator.step(Date.UTC(2026, 9, 24, 12, 0, 1))
  assert.ok(second.fix)
  const moved = distance(
    [first.fix.lon, first.fix.lat],
    [second.fix.lon, second.fix.lat],
  )
  assert.ok(moved > 4.9 && moved < 5.1, `moved ${moved} m`)
})
