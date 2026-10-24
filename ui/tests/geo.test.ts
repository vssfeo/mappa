import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bearing,
  circlePolygon,
  destination,
  distance,
  formatDms,
  lonLatToUtm,
  parseAngle,
  parseCoordinateText,
  polygonArea,
  polygonPerimeter,
  utmToLonLat,
} from '../src/geo.ts'
import {
  exportMarkers,
  importMarkers,
  type MapMarker,
} from '../src/markers.ts'

const close = (actual: number, expected: number, tolerance: number) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} is not within ${tolerance} of ${expected}`,
  )
}

test('great-circle distance Moscow to Saint Petersburg', () => {
  const value = distance([37.6173, 55.7558], [30.3159, 59.9391])
  close(value, 634_500, 2_000)
})

test('initial bearing is measured clockwise from north', () => {
  close(bearing([0, 0], [0, 1]), 0, 1e-9)
  close(bearing([0, 0], [1, 0]), 90, 1e-9)
  close(bearing([0, 0], [0, -1]), 180, 1e-9)
  close(bearing([0, 0], [-1, 0]), 270, 1e-9)
})

test('destination follows a great-circle bearing', () => {
  const north = destination([37.6, 55.7], 0, 1000)
  close(distance([37.6, 55.7], north), 1000, 1)
  close(north[0], 37.6, 1e-9)
  const east = destination([0, 0], 90, 1000)
  close(east[0], 1000 / (EARTH_RADIUS * Math.PI / 180), 1e-6)
})

test('circle polygon keeps the requested radius', () => {
  const center: [number, number] = [37.6, 55.7]
  const edge: [number, number] = [37.62, 55.7]
  const ring = circlePolygon(center, edge, 64)
  assert.equal(ring.length, 64)
  for (const point of ring) close(distance(center, point), distance(center, edge), 1)
  assert.deepEqual(circlePolygon(center, center), [])
})

const EARTH_RADIUS = 6_371_008.8

test('spherical polygon area of a one-degree square at the equator', () => {
  const square = polygonArea([
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ])
  close(square, 12_363_718_145, 1_000_000)
  assert.ok(polygonPerimeter([
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]) > 440_000)
})

test('UTM forward conversion matches a known New York coordinate', () => {
  const utm = lonLatToUtm(-74.006, 40.7128)
  assert.equal(utm.zone, 18)
  assert.equal(utm.hemisphere, 'N')
  close(utm.easting, 583_960, 2)
  close(utm.northing, 4_507_351, 2)
})

test('UTM inverse round-trips both hemispheres', () => {
  for (const [lon, lat] of [
    [37.6173, 55.7558],
    [-122.45, 37.78],
    [151.2093, -33.8688],
    [18.4241, -33.9249],
  ]) {
    const restored = utmToLonLat(lonLatToUtm(lon, lat))
    close(restored[0], lon, 1e-6)
    close(restored[1], lat, 1e-6)
  }
})

test('DMS formatting and parsing round-trip', () => {
  const text = formatDms(55.7558, 'lat')
  assert.match(text, /^55°45′2[01]\.\d″N$/)
  close(parseAngle(text), 55.7558, 0.0001)
  close(parseAngle('37°37′2.3″E'), 37.6173, 0.0001)
  close(parseAngle('-33.8688'), -33.8688, 1e-9)
})

test('coordinate input accepts decimal, DMS and UTM', () => {
  const decimal = parseCoordinateText('55.7558, 37.6173')
  assert.ok(decimal)
  close(decimal.point[0], 37.6173, 1e-9)
  close(decimal.point[1], 55.7558, 1e-9)

  const comma = parseCoordinateText('55,7558; 37,6173')
  assert.ok(comma)
  close(comma.point[1], 55.7558, 1e-9)

  const dms = parseCoordinateText('55°45′20.9″N 37°37′2.3″E')
  assert.ok(dms)
  close(dms.point[0], 37.6173, 0.0002)

  const utm = parseCoordinateText('37N 413224 6179767')
  assert.ok(utm)
  close(utm.point[0], 37.6173, 1e-4)
  close(utm.point[1], 55.7558, 1e-4)

  assert.equal(parseCoordinateText('not a coordinate'), null)
  assert.equal(parseCoordinateText('12, 34, 56'), null)
})

test('CSV export and import round-trip in decimal degrees', () => {
  const markers: MapMarker[] = [
    { id: 'a', name: 'Точка; один', lon: 37.6173, lat: 55.7558 },
    { id: 'b', name: 'Point "two"', lon: -122.45, lat: 37.78, description: 'x' },
  ]
  const csv = exportMarkers(markers, 'csv', 'dd')
  assert.ok(csv.startsWith('\uFEFF'), 'CSV starts with a UTF-8 BOM')
  const parsed = importMarkers(csv, 'dd')
  assert.equal(parsed.markers.length, 2)
  assert.equal(parsed.skipped, 0)
  assert.equal(parsed.markers[0].name, 'Точка; один')
  close(parsed.markers[0].lon, 37.6173, 1e-9)
  assert.equal(parsed.markers[1].description, 'x')

  const external = importMarkers(
    '\uFEFFname;lat;lon;description\nТочка;55,7;37,6;\n',
    'dd',
  )
  assert.equal(external.markers.length, 1)
  assert.equal(external.markers[0].name, 'Точка')
  close(external.markers[0].lat, 55.7, 1e-9)
})

test('CSV UTM export and import round-trip', () => {
  const markers: MapMarker[] = [
    { id: 'a', name: 'Moscow', lon: 37.6173, lat: 55.7558 },
    { id: 'b', name: 'Sydney', lon: 151.2093, lat: -33.8688 },
  ]
  const csv = exportMarkers(markers, 'csv', 'utm')
  assert.match(csv, /zone;hemisphere;easting;northing/)
  const parsed = importMarkers(csv, 'utm')
  assert.equal(parsed.markers.length, 2)
  close(parsed.markers[0].lon, 37.6173, 1e-6)
  close(parsed.markers[0].lat, 55.7558, 1e-6)
  close(parsed.markers[1].lon, 151.2093, 1e-6)
  close(parsed.markers[1].lat, -33.8688, 1e-6)
})

test('GeoJSON export and import round-trip', () => {
  const markers: MapMarker[] = [
    { id: 'a', name: 'Один', lon: 30.3159, lat: 59.9391 },
  ]
  const json = exportMarkers(markers, 'geojson', 'dd')
  assert.match(json, /"FeatureCollection"/)
  const parsed = importMarkers(json, 'dd')
  assert.equal(parsed.markers.length, 1)
  assert.equal(parsed.markers[0].name, 'Один')
  close(parsed.markers[0].lon, 30.3159, 1e-9)
})

test('GPX export and import round-trip with XML escaping', () => {
  const markers: MapMarker[] = [
    {
      id: 'a',
      name: 'A & B <точка>',
      lon: 37.6173,
      lat: 55.7558,
      description: 'one "two"',
    },
  ]
  const gpx = exportMarkers(markers, 'gpx', 'dd')
  assert.match(gpx, /<gpx version="1.1"/)
  const parsed = importMarkers(gpx, 'dd')
  assert.equal(parsed.markers.length, 1)
  assert.equal(parsed.markers[0].name, 'A & B <точка>')
  assert.equal(parsed.markers[0].description, 'one "two"')
  close(parsed.markers[0].lon, 37.6173, 1e-6)
})

test('KML export and import round-trip', () => {
  const markers: MapMarker[] = [
    { id: 'a', name: 'Точка', lon: -122.45, lat: 37.78 },
  ]
  const kml = exportMarkers(markers, 'kml', 'dd')
  assert.match(kml, /<kml xmlns=/)
  const parsed = importMarkers(kml, 'dd')
  assert.equal(parsed.markers.length, 1)
  assert.equal(parsed.markers[0].name, 'Точка')
  close(parsed.markers[0].lon, -122.45, 1e-6)
})

test('marker folders, icons and colours survive each text format', () => {
  const markers: MapMarker[] = [
    {
      id: 'a',
      name: 'Лагерь',
      lon: 37.6,
      lat: 55.7,
      folder: 'Поле',
      icon: '⛺',
      color: '#3ddc97',
    },
  ]
  for (const format of ['geojson', 'csv', 'kml'] as const) {
    const text = exportMarkers(markers, format, 'dd')
    const parsed = importMarkers(text, 'dd')
    assert.equal(parsed.markers.length, 1, format)
    assert.equal(parsed.markers[0].folder, 'Поле', format)
    assert.equal(parsed.markers[0].icon, '⛺', format)
    assert.equal(parsed.markers[0].color, '#3ddc97', format)
  }
})

test('KML import ignores line geometries', () => {
  const kml = `<kml><Document><Placemark><name>Route</name>
    <LineString><coordinates>10,20 11,21</coordinates></LineString>
  </Placemark></Document></kml>`
  const parsed = importMarkers(kml, 'dd')
  assert.equal(parsed.markers.length, 0)
  assert.equal(parsed.skipped, 1)
})

test('KML import strips HTML from descriptions', () => {
  const kml = `<?xml version="1.0"?><kml><Document><Placemark>
    <name>P</name><description><![CDATA[<b>bold</b> note]]></description>
    <Point><coordinates>10.5,20.5,0</coordinates></Point>
  </Placemark></Document></kml>`
  const parsed = importMarkers(kml, 'dd')
  assert.equal(parsed.markers[0].description, 'bold note')
  close(parsed.markers[0].lon, 10.5, 1e-9)
  close(parsed.markers[0].lat, 20.5, 1e-9)
})

test('invalid CSV rows are skipped without aborting the import', () => {
  const csv = 'name;lat;lon\nok;55.7;37.6\nbroken;north;east\n'
  const parsed = importMarkers(csv, 'dd')
  assert.equal(parsed.markers.length, 1)
  assert.equal(parsed.skipped, 1)
})
