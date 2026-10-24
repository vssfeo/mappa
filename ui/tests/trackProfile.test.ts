import assert from 'node:assert/strict'
import test from 'node:test'

import { distance, type LonLat } from '../src/geo.ts'
import {
  buildTrackProfile,
  downsampleSamples,
  sampleAt,
} from '../src/trackProfile.ts'

const track: LonLat[] = [
  [0, 0],
  [0.01, 0],
  [0.02, 0],
  [0.03, 0],
]

test('builds elevation and speed profile aligned by distance', () => {
  const model = buildTrackProfile(track, {
    elevations: [100, 150, 140, 190],
    times: [
      '2026-01-01T10:00:00Z',
      '2026-01-01T10:16:40Z',
      '2026-01-01T10:33:20Z',
      '2026-01-01T10:50:00Z',
    ],
  })
  assert.equal(model.samples.length, 4)
  assert.equal(model.stats.hasElevation, true)
  assert.equal(model.stats.hasTime, true)
  assert.equal(model.stats.ascent, 100)
  assert.equal(model.stats.descent, 10)
  assert.equal(model.stats.duration, 3000)
  assert.equal(model.minElevation, 100)
  assert.equal(model.maxElevation, 190)
  const segment = distance(track[0], track[1])
  assert.ok(
    Math.abs(model.samples[1].speed! - segment / 1000) < 1e-6,
    'speed must use metres per second',
  )
  assert.ok(Math.abs(model.stats.distance - segment * 3) < 1e-6)
})

test('keeps gaps for missing elevation and time samples', () => {
  const model = buildTrackProfile(track, {
    elevations: [120, null, 135, 130],
    times: [null, null, null, null],
  })
  assert.equal(model.stats.hasElevation, true)
  assert.equal(model.stats.hasTime, false)
  assert.equal(model.stats.duration, null)
  assert.equal(model.samples[1].elevation, null)
  assert.equal(model.samples[1].speed, null)
  assert.equal(model.stats.ascent, 0)
  assert.equal(model.stats.descent, 5)
})

test('ignores implausible GPS speed spikes', () => {
  const model = buildTrackProfile(track.slice(0, 2), {
    elevations: [10, 11],
    times: ['2026-01-01T10:00:00Z', '2026-01-01T10:00:00.001Z'],
  })
  assert.equal(model.samples[1].speed, null)
  assert.equal(model.stats.maxSpeed, 0)
})

test('samples by distance and downsamples without losing endpoints', () => {
  const model = buildTrackProfile(track, {
    elevations: [100, 200, 300, 400],
    times: [],
  })
  const half = sampleAt(model, 0.5)
  assert.ok(half)
  assert.ok(Math.abs(half.distance - model.stats.distance / 2) < 1e-6)
  assert.ok(
    half.elevation !== null &&
      half.elevation > 200 &&
      half.elevation < 300,
  )
  assert.equal(sampleAt(model, 0)?.elevation, 100)
  assert.equal(sampleAt(model, 1)?.elevation, 400)
  assert.equal(sampleAt({ ...model, samples: [] }, 0.5), null)

  const many = buildTrackProfile(
    Array.from({ length: 1000 }, (_, index) => [index / 10_000, 0] as LonLat),
    {
      elevations: Array.from({ length: 1000 }, (_, index) => index),
      times: [],
    },
  )
  const reduced = downsampleSamples(many.samples, 50)
  assert.equal(reduced.length, 50)
  assert.equal(reduced[0], many.samples[0])
  assert.equal(reduced[reduced.length - 1], many.samples[many.samples.length - 1])
})

test('tracks without a profile still expose their length', () => {
  const model = buildTrackProfile(track)
  assert.equal(model.stats.hasElevation, false)
  assert.equal(model.stats.hasTime, false)
  assert.equal(model.stats.maxSpeed, 0)
  assert.ok(Math.abs(model.stats.distance - distance(track[0], track[3])) < 1e-6)
})
