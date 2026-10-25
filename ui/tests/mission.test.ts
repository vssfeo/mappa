import assert from 'node:assert/strict'
import test from 'node:test'
import { missionKml, missionKmz, qgcPlan, surveyWaypoints, type MissionPoint } from '../src/mission.ts'

const points: MissionPoint[] = [
  { name: 'Start', lon: 34.1, lat: 44.9, alt: 100 },
  { name: 'Ridge <A&B>', lon: 34.2, lat: 44.95, alt: 120 },
  { name: 'End', lon: 34.3, lat: 45.0, alt: 90 },
]

test('builds a QGC plan with takeoff, waypoints and RTL', () => {
  const plan = JSON.parse(qgcPlan(points, { cruiseSpeed: 12 }))
  assert.equal(plan.fileType, 'Plan')
  assert.equal(plan.groundStation, 'Mappa')
  assert.equal(plan.mission.cruiseSpeed, 12)
  assert.equal(plan.mission.plannedHomePosition[0], 44.9)
  assert.equal(plan.mission.plannedHomePosition[1], 34.1)
  const commands = plan.mission.items.map((item: { command: number }) => item.command)
  assert.deepEqual(commands, [22, 16, 16, 16, 20])
  for (const item of plan.mission.items) {
    assert.equal(item.frame, 3)
    assert.equal(item.AltitudeMode, 1)
  }
  assert.equal(plan.mission.items[1].params[4], 44.9)
  assert.equal(plan.mission.items[1].params[5], 34.1)
  assert.equal(plan.mission.items[1].Altitude, 100)
})

test('switches frames and altitude mode for ASL missions', () => {
  const plan = JSON.parse(qgcPlan(points, { mode: 'asl' }))
  assert.equal(plan.mission.globalPlanAltitudeMode, 0)
  for (const item of plan.mission.items) {
    assert.equal(item.frame, 0)
    assert.equal(item.AltitudeMode, 0)
  }
})

test('rejects an empty mission', () => {
  assert.throws(() => qgcPlan([]))
  assert.throws(() => missionKml([]))
})

test('writes KML with a line, placemarks and escaped names', () => {
  const kml = missionKml(points, 'Mission <1>', 'agl')
  assert.match(kml, /<LineString>/)
  assert.match(kml, /relativeToGround/)
  assert.equal((kml.match(/<Placemark>/g) ?? []).length, points.length + 1)
  assert.match(kml, /Ridge &lt;A&amp;B&gt;/)
  assert.match(kml, /Mission &lt;1&gt;/)
  assert.match(kml, /34\.1,44\.9,100/)
})

test('uses absolute altitudes when asked', () => {
  assert.match(missionKml(points, 'm', 'asl'), /<altitudeMode>absolute<\/altitudeMode>/)
})

test('packs the KML into a stored ZIP', () => {
  const kmz = missionKmz(points, 'm')
  assert.equal(kmz[0], 0x50)
  assert.equal(kmz[1], 0x4b)
  const text = new TextDecoder().decode(kmz)
  assert.match(text, /doc\.kml/)
  assert.match(text, /<LineString>/)
})


test('adds an inclusion geofence circle', () => {
  const plan = JSON.parse(qgcPlan(points, { geofenceRadiusM: 500 }))
  assert.equal(plan.geoFence.circles.length, 1)
  assert.equal(plan.geoFence.circles[0].circle.radius, 500)
  assert.deepEqual(plan.geoFence.circles[0].circle.center, [44.9, 34.1])
  assert.equal(plan.geoFence.circles[0].inclusion, true)
})

test('no geofence when the radius is zero', () => {
  const plan = JSON.parse(qgcPlan(points))
  assert.equal(plan.geoFence.circles.length, 0)
})

test('builds a lawnmower survey inside a polygon', () => {
  const polygon: [number, number][] = [
    [34.0, 44.9],
    [34.01, 44.9],
    [34.01, 44.91],
    [34.0, 44.91],
    [34.0, 44.9],
  ]
  const waypoints = surveyWaypoints(polygon, 100)
  assert.ok(waypoints.length >= 10, `only ${waypoints.length} waypoints`)
  assert.equal(waypoints.length % 2, 0)
  for (const [lon, lat] of waypoints) {
    assert.ok(lon >= 34.0 && lon <= 34.01)
    assert.ok(lat >= 44.9 && lat <= 44.91)
  }
  // Boustrophedon: every second line runs the other way.
  const first = waypoints[0]
  const third = waypoints[2]
  assert.ok(first[0] < third[0] || first[0] > third[0])
})

test('survey rejects a bad spacing', () => {
  assert.throws(() => surveyWaypoints([[0, 0], [1, 0], [1, 1]], 0))
  assert.deepEqual(surveyWaypoints([[0, 0], [1, 0]], 100), [])
})
