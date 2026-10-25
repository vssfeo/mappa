/**
 * ESRI Shapefile + DBF reader.
 *
 * Supports the classic 2D shape types (plus Z/M variants, whose elevation and
 * measure are ignored). The companion `.prj` is understood for WGS84,
 * Web Mercator and WGS84 UTM; other systems are rejected with a clear error
 * instead of silently misplacing features.
 */

import type { Feature, Geometry, Position } from 'geojson'
import { utmToLonLat } from './geo.ts'
import type { CrsSpec } from './native.ts'
import { projectionFromWkt } from './prj.ts'
import type { VectorFeature } from './vectorLayers.ts'
import { tr } from './locale.ts'

export interface ShapefileImport {
  features: VectorFeature[]
  skipped: number
  srs: string
  /** Set when coordinates still need a native proj4 transform. */
  projection: CrsSpec | null
}

export interface ShapefileOptions {
  /**
   * Return projected coordinates untouched together with `projection` when
   * the `.prj` names a system the synchronous reader does not know.
   */
  deferProjection?: boolean
}

interface DbfField {
  name: string
  type: string
  length: number
  decimals: number
}

interface DbfRow {
  deleted: boolean
  values: Record<string, unknown>
}

const MAX_FEATURES = 100_000
const MAX_POINTS = 2_000_000

type Transform = (x: number, y: number) => [number, number]

const identity: Transform = (x, y) => [x, y]

function webMercatorToWgs84(x: number, y: number): [number, number] {
  const radius = 6_378_137
  const lon = (x / radius) * (180 / Math.PI)
  const lat = (2 * Math.atan(Math.exp(y / radius)) - Math.PI / 2) * (180 / Math.PI)
  return [lon, lat]
}

function projectionFromPrj(
  prj: string | null,
  deferProjection = false,
): {
  transform: Transform
  srs: string
  projection: CrsSpec | null
  bounded: boolean
} {
  if (!prj || !prj.trim()) {
    return {
      transform: identity,
      srs: tr('WGS84 (предположение)', 'WGS84 (assumed)'),
      projection: null,
      bounded: true,
    }
  }
  const upper = prj.toUpperCase()
  const utm = upper.match(/UTM[_ ]*ZONE[_ ]*(\d{1,2})([NS])/)
  if (utm) {
    const zone = Number(utm[1])
    const hemisphere = utm[2] as 'N' | 'S'
    if (zone >= 1 && zone <= 60) {
      return {
        transform: (x, y) =>
          utmToLonLat({ zone, hemisphere, easting: x, northing: y }),
        srs: `WGS84 / UTM ${zone}${hemisphere}`,
        projection: null,
        bounded: true,
      }
    }
  }
  if (
    /PSEUDO[-_ ]?MERCATOR|WEB[_ ]?MERCATOR|EPSG[:"]*3857|EPSG[:"]*900913/.test(
      upper,
    )
  ) {
    return {
      transform: webMercatorToWgs84,
      srs: 'EPSG:3857',
      projection: null,
      bounded: true,
    }
  }
  if (
    !/PROJCS|PROJCRS/.test(upper) &&
    /GEOGCS|GEOGCRS|WGS[ _]?84|EPSG[:"]*4326/.test(upper)
  ) {
    return {
      transform: identity,
      srs: 'EPSG:4326',
      projection: null,
      bounded: true,
    }
  }
  const wkt = projectionFromWkt(prj)
  if (wkt) {
    if (!deferProjection) {
      throw new Error(
        tr(
        'Для этой проекции .prj нужна нативная перепроекция (доступна в приложении)',
        'This .prj projection needs native reprojection (available in the app)',
      ),
      )
    }
    return {
      transform: identity,
      srs: wkt.label,
      projection: wkt.spec,
      bounded: false,
    }
  }
  throw new Error(
    tr(
      'Проекция из .prj не поддерживается. Пересохраните слой в WGS84, Web Mercator или UTM WGS84.',
      'The projection in .prj is not supported. Re-save the layer in WGS84, Web Mercator or UTM WGS84.',
    ),
  )
}

function dbfDecoder(data: ArrayBuffer, headerLength: number, recordLength: number): TextDecoder {
  const bytes = new Uint8Array(data)
  const start = Math.min(bytes.length, headerLength)
  const end = Math.min(bytes.length, start + Math.max(recordLength * 16, 1))
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end))
    return new TextDecoder('utf-8')
  } catch {
    try {
      return new TextDecoder('windows-1251')
    } catch {
      return new TextDecoder('utf-8')
    }
  }
}

function parseDbf(data: ArrayBuffer): DbfRow[] {
  const view = new DataView(data)
  if (view.byteLength < 32) throw new Error(tr('DBF слишком короткий', 'The DBF is too short'))
  const count = view.getUint32(4, true)
  const headerLength = view.getUint16(8, true)
  const recordLength = view.getUint16(10, true)
  if (headerLength < 33 || recordLength === 0) throw new Error(tr('Повреждён заголовок DBF', 'The DBF header is damaged'))
  const bytes = new Uint8Array(data)
  const decoder = dbfDecoder(data, headerLength, recordLength)
  const fields: DbfField[] = []
  let cursor = 32
  while (cursor + 32 <= headerLength && bytes[cursor] !== 0x0d) {
    const nameBytes = bytes.subarray(cursor, cursor + 11)
    const zero = nameBytes.indexOf(0)
    const name = decoder
      .decode(zero >= 0 ? nameBytes.subarray(0, zero) : nameBytes)
      .trim()
    const type = String.fromCharCode(bytes[cursor + 11] ?? 0).toUpperCase()
    const length = bytes[cursor + 16] ?? 0
    const decimals = bytes[cursor + 17] ?? 0
    if (name) fields.push({ name, type, length, decimals })
    cursor += 32
  }

  const rows: DbfRow[] = []
  for (let index = 0; index < count; index += 1) {
    const start = headerLength + index * recordLength
    if (start + recordLength > bytes.length) break
    const deleted = bytes[start] === 0x2a
    let offset = start + 1
    const values: Record<string, unknown> = {}
    for (const field of fields) {
      const end = Math.min(start + recordLength, offset + field.length)
      const raw = decoder.decode(bytes.subarray(offset, end)).trim()
      offset = end
      if (!raw) continue
      if (field.type === 'N' || field.type === 'F') {
        const number = Number(raw)
        if (Number.isFinite(number)) values[field.name] = number
        else values[field.name] = raw
      } else if (field.type === 'L') {
        values[field.name] = /^[YT]$/i.test(raw)
      } else if (field.type === 'D' && /^\d{8}$/.test(raw)) {
        values[field.name] = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
      } else if (field.type !== 'M') {
        values[field.name] = raw.slice(0, 2000)
      }
    }
    rows.push({ deleted, values })
  }
  return rows
}

const signedArea = (ring: Position[]): number => {
  let area = 0
  for (let index = 1; index < ring.length; index += 1) {
    area +=
      ring[index - 1][0] * ring[index][1] -
      ring[index][0] * ring[index - 1][1]
  }
  return area / 2
}

const pointInRing = (position: Position, ring: Position[]): boolean => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    if (
      yi > position[1] !== yj > position[1] &&
      position[0] < ((xj - xi) * (position[1] - yi)) / (yj - yi) + xi
    ) {
      inside = !inside
    }
  }
  return inside
}

function closeRing(ring: Position[]): Position[] {
  if (ring.length < 3) return ring
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return [...ring, [first[0], first[1]]]
  }
  return ring
}

/** Shapefile polygons: clockwise outer rings, counter-clockwise holes. */
function polygonParts(rings: Position[][]): Position[][][] {
  const outers: { ring: Position[]; holes: Position[][] }[] = []
  const holes: Position[][] = []
  for (const raw of rings) {
    const ring = closeRing(raw)
    if (ring.length < 4) continue
    if (signedArea(ring) < 0) outers.push({ ring, holes: [] })
    else holes.push(ring)
  }
  for (const hole of holes) {
    const owner = outers.find((outer) => pointInRing(hole[0], outer.ring))
    if (owner) owner.holes.push(hole)
    else outers.push({ ring: hole, holes: [] })
  }
  return outers.map(({ ring, holes }) => [ring, ...holes])
}

export function parseShapefile(
  shp: ArrayBuffer,
  dbf: ArrayBuffer | null,
  prj: string | null,
  options: ShapefileOptions = {},
): ShapefileImport {
  const view = new DataView(shp)
  if (view.byteLength < 100 || view.getInt32(0, false) !== 9994) {
    throw new Error(tr('Файл не является Shapefile (.shp)', 'The file is not a shapefile (.shp)'))
  }
  const declared = view.getInt32(24, false) * 2
  const length = Math.min(view.byteLength, declared > 0 ? declared : view.byteLength)
  const { transform, srs, projection, bounded } = projectionFromPrj(
    prj,
    options.deferProjection,
  )
  const rows = dbf ? parseDbf(dbf) : []
  const features: VectorFeature[] = []
  let skipped = 0
  let points = 0
  let offset = 100
  let record = 0

  const convert = (x: number, y: number): Position | null => {
    points += 1
    if (points > MAX_POINTS) {
      throw new Error(tr(
                        'Слишком много координат: лимит {p0}',
                        'Too many coordinates: the limit is {p0}',
                        { p0: MAX_POINTS },
                      ))
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    const [lon, lat] = transform(x, y)
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
    if (bounded && (lon < -180 || lon > 180 || lat < -90 || lat > 90)) {
      return null
    }
    return [lon, lat]
  }
  const convertPoints = (start: number, count: number): (Position | null)[] => {
    const result: (Position | null)[] = []
    for (let index = 0; index < count; index += 1) {
      result.push(
        convert(
          view.getFloat64(start + index * 16, true),
          view.getFloat64(start + index * 16 + 8, true),
        ),
      )
    }
    return result
  }

  while (offset + 8 <= length && features.length < MAX_FEATURES) {
    const contentLength = view.getInt32(offset + 4, false) * 2
    const start = offset + 8
    const end = start + contentLength
    if (contentLength < 4 || end > length) break
    const type = view.getInt32(start, true)
    const base = type >= 31 ? -1 : type % 10
    const properties = rows[record]?.values ?? {}
    const deleted = rows[record]?.deleted ?? false
    record += 1
    let geometry: Geometry | null = null

    if (!deleted) {
      if (base === 1 && contentLength >= 20) {
        const position = convert(
          view.getFloat64(start + 4, true),
          view.getFloat64(start + 12, true),
        )
        if (position) geometry = { type: 'Point', coordinates: position }
      } else if (base === 8 && contentLength >= 40) {
        const count = view.getInt32(start + 36, true)
        if (count >= 0 && 40 + count * 16 <= contentLength) {
          const coordinates = convertPoints(start + 40, count).filter(
            (position): position is Position => position !== null,
          )
          if (coordinates.length > 0) {
            geometry = { type: 'MultiPoint', coordinates }
          }
        }
      } else if ((base === 3 || base === 5) && contentLength >= 44) {
        const parts = view.getInt32(start + 36, true)
        const count = view.getInt32(start + 40, true)
        if (
          parts >= 1 &&
          count >= 0 &&
          count <= 10_000_000 &&
          44 + parts * 4 + count * 16 <= contentLength
        ) {
          const partOffsets: number[] = []
          for (let index = 0; index < parts; index += 1) {
            partOffsets.push(view.getInt32(start + 44 + index * 4, true))
          }
          const all = convertPoints(start + 44 + parts * 4, count)
          const rings: Position[][] = []
          for (let index = 0; index < parts; index += 1) {
            const from = partOffsets[index]
            const to = partOffsets[index + 1] ?? count
            if (from < 0 || to > all.length || to - from < 2) continue
            const part = all.slice(from, to)
            if (part.some((position) => position === null)) continue
            rings.push(part as Position[])
          }
          if (base === 3) {
            const lines = rings.filter((ring) => ring.length >= 2)
            if (lines.length === 1) {
              geometry = { type: 'LineString', coordinates: lines[0] }
            } else if (lines.length > 1) {
              geometry = { type: 'MultiLineString', coordinates: lines }
            }
          } else {
            const polygons = polygonParts(rings)
            if (polygons.length === 1) {
              geometry = { type: 'Polygon', coordinates: polygons[0] }
            } else if (polygons.length > 1) {
              geometry = { type: 'MultiPolygon', coordinates: polygons }
            }
          }
        }
      }
    }
    if (geometry) {
      features.push({
        type: 'Feature',
        geometry,
        properties,
      } as Feature<Geometry, Record<string, unknown>>)
    } else {
      skipped += 1
    }
    offset = end
  }
  return { features, skipped, srs, projection }
}
