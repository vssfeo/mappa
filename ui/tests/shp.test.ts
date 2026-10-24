import assert from 'node:assert/strict'
import test from 'node:test'

import { lonLatToUtm } from '../src/geo.ts'
import { parseShapefile } from '../src/shp.ts'

interface DbfField {
  name: string
  type: 'C' | 'N'
  length: number
  decimals?: number
}

function shapefile(
  shapeType: number,
  contents: ArrayBuffer[],
): ArrayBuffer {
  const total =
    100 + contents.reduce((sum, item) => sum + 8 + item.byteLength, 0)
  const buffer = new ArrayBuffer(total)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  view.setInt32(0, 9994, false)
  view.setInt32(24, total / 2, false)
  view.setInt32(28, 1000, true)
  view.setInt32(32, shapeType, true)
  let offset = 100
  contents.forEach((content, index) => {
    view.setInt32(offset, index + 1, false)
    view.setInt32(offset + 4, content.byteLength / 2, false)
    bytes.set(new Uint8Array(content), offset + 8)
    offset += 8 + content.byteLength
  })
  return buffer
}

function point(lon: number, lat: number): ArrayBuffer {
  const buffer = new ArrayBuffer(20)
  const view = new DataView(buffer)
  view.setInt32(0, 1, true)
  view.setFloat64(4, lon, true)
  view.setFloat64(12, lat, true)
  return buffer
}

function linesOrPolygon(
  shapeType: 3 | 5,
  parts: [number, number][][],
): ArrayBuffer {
  const points = parts.flat()
  const size = 4 + 32 + 4 + 4 + parts.length * 4 + points.length * 16
  const buffer = new ArrayBuffer(size)
  const view = new DataView(buffer)
  view.setInt32(0, shapeType, true)
  view.setInt32(36, parts.length, true)
  view.setInt32(40, points.length, true)
  let partOffset = 0
  parts.forEach((part, index) => {
    view.setInt32(44 + index * 4, partOffset, true)
    partOffset += part.length
  })
  let offset = 44 + parts.length * 4
  for (const [lon, lat] of points) {
    view.setFloat64(offset, lon, true)
    view.setFloat64(offset + 8, lat, true)
    offset += 16
  }
  return buffer
}

function dbf(fields: DbfField[], rows: string[][]): ArrayBuffer {
  const headerLength = 32 + fields.length * 32 + 1
  const recordLength =
    1 + fields.reduce((sum, field) => sum + field.length, 0)
  const buffer = new ArrayBuffer(headerLength + rows.length * recordLength + 1)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  const encoder = new TextEncoder()
  view.setUint8(0, 0x03)
  view.setUint32(4, rows.length, true)
  view.setUint16(8, headerLength, true)
  view.setUint16(10, recordLength, true)
  fields.forEach((field, index) => {
    const start = 32 + index * 32
    bytes.set(encoder.encode(field.name).subarray(0, 10), start)
    bytes[start + 11] = field.type.charCodeAt(0)
    bytes[start + 16] = field.length
    bytes[start + 17] = field.decimals ?? 0
  })
  bytes[headerLength - 1] = 0x0d
  rows.forEach((row, rowIndex) => {
    let offset = headerLength + rowIndex * recordLength
    bytes[offset] = 0x20
    offset += 1
    fields.forEach((field, fieldIndex) => {
      const text = row[fieldIndex] ?? ''
      const encoded = encoder.encode(text).subarray(0, field.length)
      bytes.set(encoded, offset)
      for (let index = encoded.length; index < field.length; index += 1) {
        bytes[offset + index] = 0x20
      }
      offset += field.length
    })
  })
  bytes[buffer.byteLength - 1] = 0x1a
  return buffer
}

test('imports shapefile points with DBF attributes', () => {
  const shp = shapefile(1, [point(37.6, 55.7)])
  const properties = dbf(
    [
      { name: 'NAME', type: 'C', length: 20 },
      { name: 'HEIGHT', type: 'N', length: 8, decimals: 2 },
    ],
    [['Озеро', '123.45']],
  )
  const imported = parseShapefile(shp, properties, null)
  assert.equal(imported.features.length, 1)
  assert.equal(imported.skipped, 0)
  assert.deepEqual(imported.features[0].geometry, {
    type: 'Point',
    coordinates: [37.6, 55.7],
  })
  assert.equal(imported.features[0].properties?.NAME, 'Озеро')
  assert.equal(imported.features[0].properties?.HEIGHT, 123.45)
  assert.match(imported.srs, /WGS84/)
})

test('reprojects UTM shapefile coordinates from the .prj', () => {
  const utm = lonLatToUtm(37.6, 55.7)
  const shp = shapefile(3, [
    linesOrPolygon(3, [
      [
        [utm.easting, utm.northing],
        [utm.easting + 1000, utm.northing + 1000],
      ],
    ]),
  ])
  const prj =
    'PROJCS["WGS_1984_UTM_Zone_37N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984"]],PROJECTION["Transverse_Mercator"]]'
  const imported = parseShapefile(shp, null, prj)
  assert.equal(imported.srs, 'WGS84 / UTM 37N')
  assert.equal(imported.features.length, 1)
  const geometry = imported.features[0].geometry
  assert.equal(geometry.type, 'LineString')
  if (geometry.type === 'LineString') {
    assert.ok(Math.abs(geometry.coordinates[0][0] - 37.6) < 1e-6)
    assert.ok(Math.abs(geometry.coordinates[0][1] - 55.7) < 1e-6)
  }
})

test('assembles polygon holes and rejects unsupported projections', () => {
  const outer = [
    [37, 55],
    [37, 56],
    [38, 56],
    [38, 55],
    [37, 55],
  ] as [number, number][]
  const hole = [
    [37.2, 55.2],
    [37.4, 55.2],
    [37.4, 55.4],
    [37.2, 55.4],
    [37.2, 55.2],
  ] as [number, number][]
  const imported = parseShapefile(
    shapefile(5, [linesOrPolygon(5, [outer, hole])]),
    null,
    null,
  )
  assert.equal(imported.features.length, 1)
  const geometry = imported.features[0].geometry
  assert.equal(geometry.type, 'Polygon')
  if (geometry.type === 'Polygon') {
    assert.equal(geometry.coordinates.length, 2)
  }
  assert.throws(() =>
    parseShapefile(shapefile(1, [point(1, 2)]), null, 'PROJCS["Mystery"]'),
  )
})

test('rejects files that are not shapefiles', () => {
  assert.throws(() => parseShapefile(new ArrayBuffer(40), null, null))
})
