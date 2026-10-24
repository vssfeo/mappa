/** Geodesic helpers, coordinate formatting and WGS84 UTM conversion. */

import { getLocale, tr } from './locale.ts'
import { lonLatToMgrs, mgrsToLonLat } from './mgrs.ts'

export type LonLat = [number, number]

const EARTH_RADIUS = 6_371_008.8
const WGS84_A = 6_378_137
const WGS84_F = 1 / 298.257223563
const WGS84_E2 = WGS84_F * (2 - WGS84_F)
const UTM_K0 = 0.9996

const toRad = (degrees: number) => (degrees * Math.PI) / 180
const toDeg = (radians: number) => (radians * 180) / Math.PI
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))
const wrapLongitude = (value: number) =>
  ((((value + 180) % 360) + 360) % 360) - 180

/** WGS84 bounds of an XYZ tile as `[[west, south], [east, north]]`. */
export const tileBounds = (
  z: number,
  x: number,
  y: number,
): [[number, number], [number, number]] => {
  const n = 2 ** z
  const lon = (tile: number) => (tile / n) * 360 - 180
  const lat = (tile: number) => {
    const radians = Math.atan(Math.sinh(Math.PI * (1 - (2 * tile) / n)))
    return (radians * 180) / Math.PI
  }
  return [
    [lon(x), lat(y + 1)],
    [lon(x + 1), lat(y)],
  ]
}

/** Great-circle distance in metres. */
export function distance(a: LonLat, b: LonLat): number {
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const dLat = lat2 - lat1
  const dLon = toRad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial bearing from `a` to `b`, degrees clockwise from north. */
export function bearing(a: LonLat, b: LonLat): number {
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const dLon = toRad(b[0] - a[0])
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

/** Point reached from `origin` along `azimuth` after `meters`. */
export function destination(
  origin: LonLat,
  azimuth: number,
  meters: number,
): LonLat {
  const angular = meters / EARTH_RADIUS
  const theta = toRad(azimuth)
  const lat1 = toRad(origin[1])
  const lon1 = toRad(origin[0])
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(theta),
  )
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    )
  return [wrapLongitude(toDeg(lon2)), toDeg(lat2)]
}

/**
 * Polygon approximating a geodesic circle. The first click is the centre,
 * the second fixes the radius. The ring is open; callers close it.
 */
export function circlePolygon(
  center: LonLat,
  edge: LonLat,
  steps = 64,
): LonLat[] {
  const radius = distance(center, edge)
  if (!Number.isFinite(radius) || radius < 0.5) return []
  const start = bearing(center, edge)
  const count = Math.max(12, Math.min(256, Math.round(steps)))
  return Array.from({ length: count }, (_, index) =>
    destination(center, start + (index * 360) / count, radius),
  )
}

/** Geographic midpoint of a segment. */
export function midpoint(a: LonLat, b: LonLat): LonLat {
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const dLon = toRad(b[0] - a[0])
  const bx = Math.cos(lat2) * Math.cos(dLon)
  const by = Math.cos(lat2) * Math.sin(dLon)
  const lat = Math.atan2(
    Math.sin(lat1) + Math.sin(lat2),
    Math.sqrt((Math.cos(lat1) + bx) ** 2 + by ** 2),
  )
  const lon = toRad(a[0]) + Math.atan2(by, Math.cos(lat1) + bx)
  return [wrapLongitude(toDeg(lon)), toDeg(lat)]
}

/** Sum of great-circle segment lengths in metres. */
export function pathLength(points: LonLat[]): number {
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1], points[index])
  }
  return total
}

/** Spherical polygon area in square metres. Closed implicitly. */
export function polygonArea(points: LonLat[]): number {
  if (points.length < 3) return 0
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    let delta = next[0] - current[0]
    if (delta > 180) delta -= 360
    if (delta < -180) delta += 360
    sum +=
      toRad(delta) *
      (2 + Math.sin(toRad(current[1])) + Math.sin(toRad(next[1])))
  }
  return Math.abs((sum * EARTH_RADIUS * EARTH_RADIUS) / 2)
}

/** Perimeter of a closed polygon in metres. */
export function polygonPerimeter(points: LonLat[]): number {
  if (points.length < 2) return 0
  let total = pathLength(points)
  if (points.length > 2) {
    total += distance(points[points.length - 1], points[0])
  }
  return total
}

const numberFormats = {
  ru: new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }),
  en: new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }),
}

const numberFormat = () => numberFormats[getLocale()]

/** Human-readable distance: metres below one kilometre, then kilometres. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '—'
  if (meters < 1000) return `${numberFormat().format(Math.round(meters))} m`
  return `${numberFormat().format(meters / 1000)} km`
}

/** Human-readable area: m², hectares, then km². */
export function formatArea(squareMeters: number): string {
  if (!Number.isFinite(squareMeters)) return '—'
  if (squareMeters < 10_000) {
    return `${numberFormat().format(Math.round(squareMeters))} m²`
  }
  if (squareMeters < 1_000_000) {
    return `${numberFormat().format(squareMeters / 10_000)} ${tr('га', 'ha')}`
  }
  return `${numberFormat().format(squareMeters / 1_000_000)} km²`
}

/** Bearing in the SAS.Planet style: 0–360° with one decimal. */
export function formatAzimuth(degrees: number): string {
  return `${degrees.toFixed(1)}°`
}

function decimalDegrees(value: number, digits = 6): string {
  return value.toFixed(digits)
}

/** Degrees-minutes-seconds with a hemisphere letter. */
export function formatDms(value: number, axis: 'lat' | 'lon'): string {
  const hemisphere =
    axis === 'lat' ? (value < 0 ? 'S' : 'N') : value < 0 ? 'W' : 'E'
  let remaining = Math.abs(value)
  let degrees = Math.floor(remaining)
  remaining = (remaining - degrees) * 60
  let minutes = Math.floor(remaining)
  let seconds = Math.round((remaining - minutes) * 60 * 10) / 10
  if (seconds >= 60) {
    seconds -= 60
    minutes += 1
  }
  if (minutes >= 60) {
    minutes -= 60
    degrees += 1
  }
  return `${degrees}°${String(minutes).padStart(2, '0')}′${seconds
    .toFixed(1)
    .padStart(4, '0')}″${hemisphere}`
}

/** Parses decimal degrees or a DMS string. Returns `NaN` when invalid. */
export function parseAngle(text: string): number {
  const value = text.trim()
  if (!value) return Number.NaN
  const numeric = value.replace(',', '.')
  if (/^[-+]?\d+(?:\.\d+)?$/.test(numeric)) return Number(numeric)

  const hemisphereMatch = value.match(/[NSEWnsewСЮВЗсювз]/)
  const hemisphere = hemisphereMatch?.[0]?.toUpperCase() ?? ''
  const numbers = value.match(/[-+]?\d+(?:[.,]\d+)?/g)
  if (!numbers || numbers.length === 0) return Number.NaN
  const degrees = Number(numbers[0].replace(',', '.'))
  const minutes = numbers.length > 1 ? Number(numbers[1].replace(',', '.')) : 0
  const seconds = numbers.length > 2 ? Number(numbers[2].replace(',', '.')) : 0
  if (
    !Number.isFinite(degrees) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    minutes >= 60 ||
    seconds >= 60
  ) {
    return Number.NaN
  }
  const sign =
    degrees < 0 || hemisphere === 'S' || hemisphere === 'W' ||
    hemisphere === 'Ю' || hemisphere === 'З'
      ? -1
      : 1
  return sign * (Math.abs(degrees) + minutes / 60 + seconds / 3600)
}

export interface UtmCoordinate {
  zone: number
  hemisphere: 'N' | 'S'
  easting: number
  northing: number
}

/** WGS84 longitude/latitude to UTM, including Norway/Svalbard zone rules. */
export function lonLatToUtm(lon: number, lat: number): UtmCoordinate {
  const clampedLat = clamp(lat, -80, 84)
  let zone = Math.floor((wrapLongitude(lon) + 180) / 6) + 1
  if (clampedLat >= 56 && clampedLat < 64 && lon >= 3 && lon < 12) zone = 32
  if (clampedLat >= 72 && clampedLat < 84) {
    if (lon >= 0 && lon < 9) zone = 31
    else if (lon < 21) zone = 33
    else if (lon < 33) zone = 35
    else if (lon < 42) zone = 37
  }

  const lonOrigin = (zone - 1) * 6 - 180 + 3
  const latRad = toRad(clampedLat)
  const lonRad = toRad(wrapLongitude(lon))
  const originRad = toRad(lonOrigin)
  const e2 = WGS84_E2
  const ep2 = e2 / (1 - e2)
  const n = WGS84_A / Math.sqrt(1 - e2 * Math.sin(latRad) ** 2)
  const t = Math.tan(latRad) ** 2
  const c = ep2 * Math.cos(latRad) ** 2
  const a = Math.cos(latRad) * (lonRad - originRad)

  const m =
    WGS84_A *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * latRad -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) *
        Math.sin(2 * latRad) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * latRad) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * latRad))

  const easting =
    UTM_K0 *
      n *
      (a +
        ((1 - t + c) * a ** 3) / 6 +
        ((5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * a ** 5) / 120) +
    500_000

  let northing =
    UTM_K0 *
    (m +
      n *
        Math.tan(latRad) *
        (a ** 2 / 2 +
          ((5 - t + 9 * c + 4 * c ** 2) * a ** 4) / 24 +
          ((61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * a ** 6) / 720))

  const hemisphere: 'N' | 'S' = clampedLat < 0 ? 'S' : 'N'
  if (hemisphere === 'S') northing += 10_000_000

  return { zone, hemisphere, easting, northing }
}

/** UTM to WGS84 longitude/latitude. */
export function utmToLonLat(coordinate: UtmCoordinate): LonLat {
  const { zone, hemisphere, easting } = coordinate
  let { northing } = coordinate
  const e2 = WGS84_E2
  const ep2 = e2 / (1 - e2)
  const x = easting - 500_000
  if (hemisphere === 'S') northing -= 10_000_000
  const m = northing / UTM_K0
  const mu =
    m /
    (WGS84_A *
      (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256))
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2))

  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu)

  const sin = Math.sin(phi1)
  const cos = Math.cos(phi1)
  const tan = Math.tan(phi1)
  const n1 = WGS84_A / Math.sqrt(1 - e2 * sin ** 2)
  const t1 = tan ** 2
  const c1 = ep2 * cos ** 2
  const r1 =
    (WGS84_A * (1 - e2)) / (1 - e2 * sin ** 2) ** 1.5
  const d = x / (n1 * UTM_K0)

  const lat =
    phi1 -
    ((n1 * tan) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) *
          d ** 6) /
          720)
  const lon =
    toRad((zone - 1) * 6 - 180 + 3) +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) *
        d ** 5) /
        120) /
      cos

  return [wrapLongitude(toDeg(lon)), toDeg(lat)]
}

export interface ParsedCoordinate {
  point: LonLat
  kind: 'dd' | 'dms' | 'utm' | 'mgrs'
}

const parseDecimal = (value: string) =>
  Number(value.replace(/\s/g, '').replace(',', '.'))

const validPoint = (lon: number, lat: number) =>
  Number.isFinite(lon) &&
  Number.isFinite(lat) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lon) <= 180

const hemisphereOf = (text: string): 'lat' | 'lon' | null => {
  if (/[NSnSsСЮсю]/.test(text)) return 'lat'
  if (/[EWewВЗвз]/.test(text)) return 'lon'
  return null
}

/**
 * Parses a pasted coordinate: decimal degrees, DMS or UTM
 * (`37N 413494 6180944`, zones with latitude bands are accepted too).
 */
export function parseCoordinateText(text: string): ParsedCoordinate | null {
  const source = text.trim()
  if (!source) return null

  const mgrs = mgrsToLonLat(source)
  if (mgrs) return { point: mgrs, kind: 'mgrs' }

  const tokens = source.split(/[\s,;]+/).filter(Boolean)
  const zoneToken = tokens[0]?.match(/^(\d{1,2})([C-HJ-NP-XNSСЮ])?$/i)
  if (zoneToken && tokens.length >= 3) {
    let index = 1
    let hemisphere: 'N' | 'S' | null = null
    const zoneLetter = (zoneToken[2] ?? '').toUpperCase()
    if (['N', 'С'].includes(zoneLetter)) hemisphere = 'N'
    else if (['S', 'Ю'].includes(zoneLetter)) hemisphere = 'S'
    else if (zoneLetter >= 'C' && zoneLetter <= 'M') hemisphere = 'S'
    else if (zoneLetter) hemisphere = 'N'

    const next = tokens[index]?.toUpperCase()
    if (next === 'N' || next === 'S' || next === 'С' || next === 'Ю') {
      hemisphere = next === 'N' || next === 'С' ? 'N' : 'S'
      index += 1
    }
    const easting = parseDecimal(
      (tokens[index] ?? '').replace(/[EeВв]$/, ''),
    )
    const northing = parseDecimal(
      (tokens[index + 1] ?? '').replace(/[NnСс]$/, ''),
    )
    if (
      Number.isFinite(easting) &&
      Number.isFinite(northing) &&
      easting >= 100_000 &&
      easting <= 900_000 &&
      northing >= 0 &&
      northing <= 10_000_000
    ) {
      const point = utmToLonLat({
        zone: Number(zoneToken[1]),
        hemisphere: hemisphere ?? 'N',
        easting,
        northing,
      })
      if (validPoint(point[0], point[1])) return { point, kind: 'utm' }
    }
  }

  const hemisphereChunks = source.match(/[^NSEWСЮВЗ,;]+[NSEWСЮВЗ]/gi)
  if (hemisphereChunks && hemisphereChunks.length === 2) {
    const first = parseAngle(hemisphereChunks[0])
    const second = parseAngle(hemisphereChunks[1])
    const firstAxis = hemisphereOf(hemisphereChunks[0])
    const secondAxis = hemisphereOf(hemisphereChunks[1])
    if (
      Number.isFinite(first) &&
      Number.isFinite(second) &&
      firstAxis !== secondAxis
    ) {
      const lat = firstAxis === 'lat' ? first : second
      const lon = firstAxis === 'lon' ? first : second
      if (validPoint(lon, lat)) {
        return { point: [lon, lat], kind: 'dms' }
      }
    }
  }

  const parts = source
    .split(source.includes(';') ? /;/ : /,/)
    .map((part) => part.trim())
  if (parts.length === 2) {
    const first = parseAngle(parts[0])
    const second = parseAngle(parts[1])
    if (Number.isFinite(first) && Number.isFinite(second)) {
      const latFirst = Math.abs(first) <= 90 && Math.abs(second) <= 180
      const lat = latFirst ? first : second
      const lon = latFirst ? second : first
      if (validPoint(lon, lat)) {
        return { point: [lon, lat], kind: 'dd' }
      }
    }
  }

  const numeric = source.match(/[-+]?\d+(?:[.,]\d+)?/g)
  if (numeric && numeric.length === 2) {
    const lat = parseAngle(numeric[0])
    const lon = parseAngle(numeric[1])
    if (validPoint(lon, lat)) {
      return { point: [lon, lat], kind: 'dd' }
    }
  }

  return null
}

/** Formats a coordinate pair for the marker list. */
export function formatCoordinatePair(
  lon: number,
  lat: number,
  format: 'dd' | 'dms' | 'utm' | 'mgrs',
): string {
  if (format === 'dms') {
    return `${formatDms(lat, 'lat')}, ${formatDms(lon, 'lon')}`
  }
  if (format === 'utm') {
    const utm = lonLatToUtm(lon, lat)
    return `${utm.zone}${utm.hemisphere} ${Math.round(utm.easting)}E ${Math.round(utm.northing)}N`
  }
  if (format === 'mgrs') {
    return lonLatToMgrs(lon, lat) ?? '—'
  }
  return `${decimalDegrees(lat, 5)}, ${decimalDegrees(lon, 5)}`
}
