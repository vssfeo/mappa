/** SK-42 Gauss-Krüger zone helpers (EPSG:28403…28432). */

export const SK42_ZONE_MIN = 3
export const SK42_ZONE_MAX = 32

/** Picks the 6° Gauss-Krüger zone that contains the longitude. */
export function sk42Zone(lon: number): number | null {
  if (!Number.isFinite(lon) || lon < 12 || lon >= 180) return null
  const zone = Math.floor(lon / 6) + 1
  return zone >= SK42_ZONE_MIN && zone <= SK42_ZONE_MAX ? zone : null
}

/** Conventional SK-42 easting carries the zone number: 7 413 187.97. */
export function sk42ZoneFromY(y: number): number | null {
  if (!Number.isFinite(y) || y <= 0) return null
  const zone = Math.floor(y / 1_000_000)
  return zone >= SK42_ZONE_MIN && zone <= SK42_ZONE_MAX ? zone : null
}

export const sk42Epsg = (zone: number): number => 28400 + zone
