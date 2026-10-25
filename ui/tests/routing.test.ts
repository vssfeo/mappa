import assert from 'node:assert/strict'
import test from 'node:test'

import type { MapFeature } from '../src/features.ts'
import {
  RouteError,
  buildIsochrone,
  buildRoute,
  buildSteps,
  distanceToRoute,
  routeCorridor,
  routeLines,
} from '../src/routing.ts'

const a: [number, number] = [37.6, 55.75]
const b: [number, number] = [37.61, 55.75]
const c: [number, number] = [37.62, 55.75]
const north: [number, number] = [37.61, 55.76]

const expectCode = (code: string, run: () => unknown) => {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof RouteError)
    assert.equal(error.code, code)
    return true
  })
}

test('routes along connected lines and reports the path', () => {
  const result = buildRoute([[a, b, c], [b, north]], a, north, 5)
  assert.deepEqual(result.coordinates, [a, b, north])
  assert.ok(result.distance > 1_600 && result.distance < 1_900)
  assert.deepEqual(result.snappedStart, a)
  assert.deepEqual(result.snappedEnd, north)
  assert.equal(result.stats.lines, 2)
})

test('snap tolerance joins nearly touching line ends', () => {
  const b2: [number, number] = [37.61003, 55.75]
  assert.equal(
    buildRoute([[a, b], [b2, c]], a, c, 10).coordinates.length,
    3,
  )
  expectCode('no-path', () => buildRoute([[a, b], [b2, c]], a, c, 0.5))
})

test('rejects missing networks and distant endpoints', () => {
  expectCode('no-lines', () => buildRoute([], a, b, 10))
  expectCode('start-snap', () => buildRoute([[a, b]], [38, 56], b, 10))
  expectCode('end-snap', () => buildRoute([[a, b]], a, [38, 56], 10))
})

test('measures distance to a polyline in metres', () => {
  const off = distanceToRoute([37.61, 55.751], [a, b, c])
  assert.ok(off > 105 && off < 118)
  assert.equal(distanceToRoute(b, [a, b, c]), 0)
})

test('collects lines from features and vector layers only when enabled', () => {
  const feature: MapFeature = {
    id: 'f1',
    name: 'road',
    kind: 'line',
    coordinates: [a, b],
    color: '#ffffff',
  }
  const base = {
    features: [feature],
    vectorLayers: [],
    useFeatures: true,
    useVectors: false,
  }
  assert.deepEqual(routeLines(base), [[a, b]])
  assert.deepEqual(routeLines({ ...base, useFeatures: false }), [])
})

test('derives turn-by-turn steps from geometry', () => {
  const steps = buildSteps([a, b, north], 2_000, 240)
  assert.equal(steps[0].maneuver, 'depart')
  assert.equal(steps[steps.length - 1].maneuver, 'arrive')
  assert.ok(steps.some((step) => step.maneuver === 'turn'))
  assert.ok(steps.every((step) => step.distance >= 0))
})

test('builds a closed isochrone polygon from the line graph', () => {
  const iso = buildIsochrone([[a, b, c], [b, north]], a, 15, 50, 5)
  assert.ok(iso.reachableNodes >= 2)
  assert.ok(iso.coordinates.length >= 4)
  assert.deepEqual(iso.coordinates[0], iso.coordinates[iso.coordinates.length - 1])
  assert.ok(iso.distance > 1_000)
})

test('buffers a route into a closed download corridor', () => {
  const ring = routeCorridor([a, b, north], 250)
  assert.equal(ring.length, 7)
  assert.deepEqual(ring[0], ring[ring.length - 1])
})
