import assert from 'node:assert/strict'
import test from 'node:test'

import { readKmz } from '../src/kmz.ts'
import {
  attributeTable,
  parseVectorText,
  vectorBounds,
} from '../src/vectorLayers.ts'
import { childText, parseXml } from '../src/xml.ts'
import { createStoredZip } from '../src/zip.ts'

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)

function storedZip(name: string, contents: string): ArrayBuffer {
  const nameBytes = encode(name)
  const data = encode(contents)
  const local = new Uint8Array(30 + nameBytes.length + data.length)
  const central = new Uint8Array(46 + nameBytes.length)
  const eocd = new Uint8Array(22)
  const localView = new DataView(local.buffer)
  const centralView = new DataView(central.buffer)
  const eocdView = new DataView(eocd.buffer)

  localView.setUint32(0, 0x04034b50, true)
  localView.setUint16(4, 20, true)
  localView.setUint16(8, 0, true)
  localView.setUint32(14, 0, true)
  localView.setUint32(18, data.length, true)
  localView.setUint32(22, data.length, true)
  localView.setUint16(26, nameBytes.length, true)
  local.set(nameBytes, 30)
  local.set(data, 30 + nameBytes.length)

  centralView.setUint32(0, 0x02014b50, true)
  centralView.setUint16(4, 20, true)
  centralView.setUint16(6, 20, true)
  centralView.setUint16(10, 0, true)
  centralView.setUint32(20, data.length, true)
  centralView.setUint32(24, data.length, true)
  centralView.setUint16(28, nameBytes.length, true)
  centralView.setUint32(42, 0, true)
  central.set(nameBytes, 46)

  const centralOffset = local.length
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, 1, true)
  eocdView.setUint16(10, 1, true)
  eocdView.setUint32(12, central.length, true)
  eocdView.setUint32(16, centralOffset, true)

  const archive = new Uint8Array(local.length + central.length + eocd.length)
  archive.set(local)
  archive.set(central, local.length)
  archive.set(eocd, local.length + central.length)
  return archive.buffer
}

const GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [37.6, 55.7] },
      properties: { name: 'Точка', height: 120, nested: { skip: true } },
    },
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [37, 55],
            [38, 55],
            [38, 56],
          ],
        ],
      },
      properties: { name: 'Треугольник', ok: true },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [400, 55] },
      properties: { name: 'Плохая' },
    },
  ],
})

test('imports GeoJSON, closes rings and drops invalid coordinates', () => {
  const parsed = parseVectorText(GEOJSON, 'geojson')
  assert.equal(parsed.features.length, 2)
  assert.equal(parsed.skipped, 1)
  const polygon = parsed.features[1].geometry
  assert.equal(polygon.type, 'Polygon')
  if (polygon.type === 'Polygon') {
    assert.deepEqual(polygon.coordinates[0][0], polygon.coordinates[0][3])
    assert.equal(polygon.coordinates[0].length, 4)
  }
  assert.deepEqual(parsed.features[0].properties, {
    name: 'Точка',
    height: 120,
  })
  assert.deepEqual(vectorBounds(parsed.features), [
    [37, 55],
    [38, 56],
  ])
})

test('imports GPX waypoints, routes and track segments', () => {
  const gpx = `<?xml version="1.0"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="55.7" lon="37.6"><name>Старт</name><ele>150</ele><sym>Flag</sym></wpt>
  <rte><name>Маршрут</name>
    <rtept lat="55.7" lon="37.6"/><rtept lat="55.8" lon="37.7"/>
  </rte>
  <trk><name>Трек</name>
    <trkseg><trkpt lat="55.1" lon="37.1"/><trkpt lat="55.2" lon="37.2"/></trkseg>
    <trkseg><trkpt lat="55.3" lon="37.3"/><trkpt lat="55.4" lon="37.4"/></trkseg>
  </trk>
</gpx>`
  const parsed = parseVectorText(gpx, 'gpx')
  assert.equal(parsed.features.length, 4)
  assert.equal(parsed.features[0].geometry.type, 'Point')
  assert.equal(parsed.features[0].properties?.name, 'Старт')
  assert.equal(parsed.features[0].properties?.ele, 150)
  assert.equal(parsed.features[1].geometry.type, 'LineString')
  assert.equal(parsed.features[2].properties?.name, 'Трек · сегмент 1')
  assert.equal(parsed.features[3].properties?.name, 'Трек · сегмент 2')
})

test('imports KML styles, multigeometry and ExtendedData', () => {
  const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Style id="line"><LineStyle><color>7f0000ff</color><width>4</width></LineStyle>
      <PolyStyle><color>4d00ff00</color></PolyStyle></Style>
    <StyleMap id="mapped"><Pair><key>normal</key><styleUrl>#line</styleUrl></Pair></StyleMap>
    <Placemark>
      <name>Объект &amp; метка</name>
      <styleUrl>#mapped</styleUrl>
      <ExtendedData><Data name="owner"><value>Алиса</value></Data></ExtendedData>
      <MultiGeometry>
        <Point><coordinates>37.6,55.7,0</coordinates></Point>
        <Polygon><outerBoundaryIs><LinearRing><coordinates>
          37,55 38,55 38,56 37,56
        </coordinates></LinearRing></outerBoundaryIs></Polygon>
        <LineString><coordinates>37,55 38,56</coordinates></LineString>
      </MultiGeometry>
    </Placemark>
  </Document>
</kml>`
  const parsed = parseVectorText(kml, 'kml')
  assert.equal(parsed.features.length, 3)
  const [point, polygon, line] = parsed.features
  assert.equal(point.geometry.type, 'Point')
  assert.equal(point.properties?.name, 'Объект & метка')
  assert.equal(point.properties?.owner, 'Алиса')
  assert.equal(point.properties?.stroke, '#ff0000')
  assert.equal(point.properties?.['stroke-width'], 4)
  assert.equal(polygon.geometry.type, 'Polygon')
  assert.equal(polygon.properties?.fill, '#00ff00')
  const fillOpacity = Number(polygon.properties?.['fill-opacity'])
  assert.ok(fillOpacity > 0.19 && fillOpacity < 0.2)
  assert.equal(line.geometry.type, 'LineString')
})

test('reads stored KML from a KMZ archive', async () => {
  const kmz = storedZip(
    'doc.kml',
    '<kml><Placemark><name>KMZ</name><Point><coordinates>37,55</coordinates></Point></Placemark></kml>',
  )
  const text = await readKmz(kmz)
  assert.match(text, /<name>KMZ<\/name>/)
  const parsed = parseVectorText(text, 'kml')
  assert.equal(parsed.features.length, 1)
  await assert.rejects(() =>
    readKmz(encode('not a zip').buffer as ArrayBuffer),
  )
})

test('XML reader handles namespaces, entities and broken closing tags', () => {
  const root = parseXml(
    '<oms:root xmlns:oms="x"><oms:Item name="a&amp;b">Текст<![CDATA[<raw>]]><child>1</child></oms:Item></oms:root>',
  )
  assert.equal(root.name, 'root')
  const item = root.children[0]
  assert.equal(item.name, 'item')
  assert.equal(item.attrs.name, 'a&b')
  assert.equal(childText(item, 'child'), '1')
  assert.match(item.text, /Текст<raw>/)
})

test('writes a stored ZIP that the KMZ reader accepts', async () => {
  const kml = '<kml><Placemark><name>ZIP</name></Placemark></kml>'
  const archive = createStoredZip([
    { name: 'doc.kml', data: encode(kml) },
  ])
  assert.equal(String.fromCharCode(...archive.slice(0, 4)), 'PK\u0003\u0004')
  assert.equal(await readKmz(archive.buffer as ArrayBuffer), kml)
})

test('builds an attribute table with stable columns', () => {
  const features = [
    {
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [37, 55] },
      properties: { name: 'A', height: 10 },
    },
    {
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [38, 56] },
      properties: { owner: 'B' },
    },
  ]
  const table = attributeTable(features)
  assert.deepEqual(table.columns, ['name', 'height', 'owner'])
  assert.equal(table.rows.length, 2)
  assert.equal(table.rows[0].values.name, 'A')
  assert.equal(table.rows[0].values.height, '10')
  assert.equal(table.rows[1].values.owner, 'B')
})
