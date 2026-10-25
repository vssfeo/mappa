import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_GPSD_HOST,
  DEFAULT_GPSD_PORT,
  DEFAULT_NMEA_HOST,
  DEFAULT_NMEA_PORT,
  normalizeGnssEndpoint,
} from '../src/gnssTcp.ts'

test('GNSS TCP endpoint is trimmed and clamped', () => {
  assert.deepEqual(normalizeGnssEndpoint('  127.0.0.1  ', 10110), {
    host: DEFAULT_NMEA_HOST,
    port: DEFAULT_NMEA_PORT,
  })
  assert.deepEqual(normalizeGnssEndpoint(' receiver.local ', 0), {
    host: 'receiver.local',
    port: 1,
  })
  assert.deepEqual(normalizeGnssEndpoint('receiver.local', 99999), {
    host: 'receiver.local',
    port: 65_535,
  })
  assert.deepEqual(normalizeGnssEndpoint('', Number.NaN), {
    host: '',
    port: DEFAULT_NMEA_PORT,
  })
})

test('gpsd uses its own default endpoint', () => {
  assert.equal(DEFAULT_GPSD_HOST, '127.0.0.1')
  assert.equal(DEFAULT_GPSD_PORT, 2947)
})
