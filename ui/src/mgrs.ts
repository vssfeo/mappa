/**
 * MGRS (Military Grid Reference System) for WGS84.
 *
 * The forward form is derived from UTM. The reverse form reconstructs the
 * 100 km square from the zone set and resolves the 2,000 km row cycle by
 * checking which candidate falls inside the latitude band.
 */

import { lonLatToUtm, utmToLonLat, type LonLat } from './geo.ts'

const BANDS = 'CDEFGHJKLMNPQRSTUVWX'
const COLUMNS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const ROWS = 'ABCDEFGHJKLMNPQRSTUV'
const COLUMN_ORIGINS = [0, 8, 16, 0, 8, 16]
const ROW_ORIGINS = [0, 5, 0, 5, 0, 5]

export interface MgrsCoordinate {
  zone: number
  band: string
  square: string
  easting: number
  northing: number
  /** Digits per axis, 1–5. */
  precision: number
}

const setIndex = (zone: number): number => ((zone - 1) % 6 + 6) % 6

export function latitudeBand(lat: number): string | null {
  if (!Number.isFinite(lat) || lat < -80 || lat > 84) return null
  if (lat >= 72) return 'X'
  const index = Math.floor((lat + 80) / 8)
  return BANDS[Math.min(index, BANDS.length - 1)] ?? null
}

const bandRange = (band: string): [number, number] | null => {
  const index = BANDS.indexOf(band)
  if (index < 0) return null
  if (band === 'X') return [72, 84]
  const min = -80 + index * 8
  return [min, min + 8]
}

/** Formats WGS84 coordinates as `37U DB 35350 77110`. */
export function lonLatToMgrs(
  lon: number,
  lat: number,
  precision = 5,
): string | null {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  const band = latitudeBand(lat)
  if (!band) return null
  const utm = lonLatToUtm(lon, lat)
  const set = setIndex(utm.zone)
  const column = Math.floor(utm.easting / 100_000)
  const row = Math.floor(utm.northing / 100_000) % 20
  if (column < 1 || column > 8) return null
  const columnLetter = COLUMNS[COLUMN_ORIGINS[set] + column - 1]
  const rowLetter = ROWS[(ROW_ORIGINS[set] + row) % ROWS.length]
  if (!columnLetter || !rowLetter) return null
  const digits = Math.max(1, Math.min(5, Math.round(precision)))
  const scale = 10 ** (5 - digits)
  const easting = Math.floor((utm.easting % 100_000) / scale)
  const northing = Math.floor((utm.northing % 100_000) / scale)
  return `${utm.zone}${band} ${columnLetter}${rowLetter} ${String(easting).padStart(digits, '0')} ${String(northing).padStart(digits, '0')}`
}

/** Parses MGRS and returns WGS84 coordinates, or null for malformed input. */
export function mgrsToLonLat(text: string): LonLat | null {
  const source = text.trim().toUpperCase().replace(/\s+/g, '')
  const match = source.match(
    /^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d{0,10})$/,
  )
  if (!match) return null
  const zone = Number(match[1])
  const band = match[2]
  const columnLetter = match[3]
  const rowLetter = match[4]
  const digits = match[5] ?? ''
  if (zone < 1 || zone > 60 || digits.length % 2 !== 0) return null
  const precision = digits.length / 2
  if (precision > 5) return null
  const set = setIndex(zone)
  const columnIndex = COLUMNS.indexOf(columnLetter)
  const rowIndex = ROWS.indexOf(rowLetter)
  if (columnIndex < 0 || rowIndex < 0) return null
  const column = columnIndex - COLUMN_ORIGINS[set] + 1
  if (column < 1 || column > 8) return null
  const rowOffset = (rowIndex - ROW_ORIGINS[set] + ROWS.length) % ROWS.length
  const eastingRemainder = digits
    ? Number(digits.slice(0, precision)) * 10 ** (5 - precision)
    : 50_000
  const northingRemainder = digits
    ? Number(digits.slice(precision)) * 10 ** (5 - precision)
    : 50_000
  const easting = column * 100_000 + eastingRemainder
  const baseNorthing = rowOffset * 100_000 + northingRemainder
  const range = bandRange(band)
  if (!range) return null
  const hemisphere: 'N' | 'S' = band <= 'M' ? 'S' : 'N'

  for (const step of [0, 2_000_000, 4_000_000, 6_000_000, 8_000_000, 10_000_000]) {
    for (const sign of [1, -1]) {
      const northing = baseNorthing + sign * step
      if (northing < 0 || northing > 10_000_000) continue
      const point = utmToLonLat({ zone, hemisphere, easting, northing })
      if (point[1] >= range[0] && point[1] <= range[1]) {
        return point
      }
    }
  }
  return null
}

/** Rounds an MGRS string to a coarser precision (for display). */
export function formatMgrs(
  lon: number,
  lat: number,
  precision = 5,
): string | null {
  return lonLatToMgrs(lon, lat, precision)
}
