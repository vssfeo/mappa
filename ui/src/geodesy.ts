/**
 * Surveying helpers: UTM grid convergence, point scale and WMM declination.
 *
 * Convergence and scale are evaluated for the local UTM zone; for a custom
 * СК-42/МСК grid the value is a close approximation because those systems use
 * the same transverse Mercator mathematics.
 */

import { distance, lonLatToUtm, utmToLonLat } from './geo.ts'

const WGS84_A = 6_378_137
const WGS84_F = 1 / 298.257223563
const WGS84_E2 = WGS84_F * (2 - WGS84_F)
const DEG = Math.PI / 180

const wrap = (degrees: number): number =>
  ((((degrees + 180) % 360) + 360) % 360) - 180

const centralMeridian = (zone: number): number => (zone - 1) * 6 - 180 + 3

/** Grid convergence γ (degrees) for a UTM/transverse Mercator point. */
export function meridianConvergence(lon: number, lat: number): number {
  const utm = lonLatToUtm(lon, lat)
  const delta = wrap(lon - centralMeridian(utm.zone))
  return Math.atan2(
    Math.sin(delta * (Math.PI / 180)) *
      Math.sin(lat * (Math.PI / 180)),
    Math.cos(delta * (Math.PI / 180)),
  ) * (180 / Math.PI)
}

/**
 * UTM point scale factor, measured on a 0.0002° baseline against the local
 * WGS84 ellipsoid radii (a spherical baseline would bias the result by up to
 * 0.4 % at mid-latitudes).
 */
export function pointScaleFactor(lon: number, lat: number): number {
  const step = 0.0002
  const sinLat = Math.sin(lat * DEG)
  const w = 1 - WGS84_E2 * sinLat * sinLat
  const primeVertical = WGS84_A / Math.sqrt(w)
  const meridional = (WGS84_A * (1 - WGS84_E2)) / w ** 1.5
  const origin = lonLatToUtm(lon, lat)
  const east = lonLatToUtm(lon + step, lat)
  const north = lonLatToUtm(lon, Math.min(84, lat + step))
  const groundEast = primeVertical * Math.cos(lat * DEG) * step * DEG
  const groundNorth = meridional * step * DEG
  const scaleEast =
    Math.hypot(east.easting - origin.easting, east.northing - origin.northing) /
    groundEast
  const scaleNorth =
    Math.hypot(north.easting - origin.easting, north.northing - origin.northing) /
    groundNorth
  return (scaleEast + scaleNorth) / 2
}

/** UTM grid coordinates plus the human label used in the HUD. */
export function gridReference(lon: number, lat: number) {
  const utm = lonLatToUtm(lon, lat)
  const back = utmToLonLat(utm)
  return {
    utm,
    convergence: meridianConvergence(lon, lat),
    scale: pointScaleFactor(lon, lat),
    roundTripMeters: distance([lon, lat], back),
  }
}
