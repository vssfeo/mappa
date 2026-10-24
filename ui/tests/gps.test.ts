import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GPS_IDLE_INTERVAL,
  GPS_MIN_DISTANCE,
  gpsTrackFeature,
  normalizeGpsFix,
  shouldRecordFix,
  type GpsFix,
} from '../src/gps.ts'

const fix = (patch: Partial<GpsFix> = {}): GpsFix => ({
  lon: 37.6,
  lat: 55.7,
  accuracy: 5,
  altitude: 150,
  altitudeAccuracy: 3,
  speed: 1.4,
  heading: 92,
  timestamp: Date.parse('2026-10-24T10:00:00Z'),
  ...patch,
})

test('normalizes a geolocation position and rejects broken coordinates', () => {
  const parsed = normalizeGpsFix({
    coords: {
      longitude: 37.6,
      latitude: 55.7,
      accuracy: 4.5,
      altitude: 120,
      altitudeAccuracy: 2,
      speed: 3,
      heading: 361,
    },
    timestamp: 1_700_000_000_000,
  })
  assert.equal(parsed?.heading, 1)
  assert.equal(parsed?.altitude, 120)
  assert.equal(parsed?.accuracy, 4.5)
  assert.equal(
    normalizeGpsFix({
      coords: { longitude: 200, latitude: 55 },
      timestamp: 1,
    }),
    null,
  )
  assert.equal(
    normalizeGpsFix({ coords: { longitude: 37, latitude: 55 } }),
    null,
  )
  assert.equal(
    normalizeGpsFix({
      coords: {
        longitude: 37,
        latitude: 55,
        speed: -1,
        heading: -1,
      },
      timestamp: 1,
    })?.speed,
    null,
  )
})

test('records only accurate, moving or timed fixes', () => {
  const first = fix()
  assert.equal(shouldRecordFix(null, first), true)
  assert.equal(
    shouldRecordFix(first, fix({ accuracy: 101 })),
    false,
  )
  assert.equal(
    shouldRecordFix(first, fix({ timestamp: first.timestamp })),
    false,
  )
  assert.equal(
    shouldRecordFix(
      first,
      fix({
        lon: first.lon + GPS_MIN_DISTANCE / 111_320 / 2,
        lat: first.lat,
        timestamp: first.timestamp + 5_000,
      }),
    ),
    false,
  )
  assert.equal(
    shouldRecordFix(
      first,
      fix({
        lon: first.lon + 0.0001,
        timestamp: first.timestamp + 5_000,
      }),
    ),
    true,
  )
  assert.equal(
    shouldRecordFix(
      first,
      fix({
        lon: first.lon + 0.000001,
        timestamp: first.timestamp + GPS_IDLE_INTERVAL,
      }),
    ),
    true,
  )
})

test('builds a line feature with an aligned GPX profile', () => {
  const start = fix()
  const end = fix({
    lon: 37.601,
    altitude: null,
    timestamp: start.timestamp + 60_000,
  })
  const feature = gpsTrackFeature([start, end], 'GPS-трек')
  assert.ok(feature)
  assert.equal(feature.kind, 'line')
  assert.equal(feature.name, 'GPS-трек')
  assert.deepEqual(feature.coordinates, [
    [37.6, 55.7],
    [37.601, 55.7],
  ])
  assert.deepEqual(feature.profile?.elevations, [150, null])
  assert.deepEqual(feature.profile?.times, [
    '2026-10-24T10:00:00.000Z',
    '2026-10-24T10:01:00.000Z',
  ])
  assert.equal(gpsTrackFeature([start], 'too short'), null)
})
