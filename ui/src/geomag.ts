/**
 * World Magnetic Model 2025 declination.
 *
 * Adapted from the MIT-licensed `geomag` implementation by Jan Greis, which in
 * turn follows the NOAA/NCEI WMM reference algorithm. The Gauss coefficients
 * are the public-domain WMM2025 set (valid 2025.0–2030.0).
 */

import { G, G_DOT, H, H_DOT } from './wmmData.ts'

const A = 6378.137
const B = 6356.7523142
const R0 = 6371.2
const DEG = Math.PI / 180
const RAD = 180 / Math.PI
const MAX_DEGREE = 12

const root: number[] = Array(MAX_DEGREE + 1).fill(0)
const roots: [number, number][][] = Array.from({ length: 13 }, () =>
  Array.from({ length: 13 }, () => [0, 0] as [number, number]),
)
for (let n = 2; n <= MAX_DEGREE; n += 1) {
  root[n] = Math.sqrt((2 * n - 1) / (2 * n))
}
for (let m = 0; m <= MAX_DEGREE; m += 1) {
  const square = m * m
  for (let n = Math.max(m + 1, 2); n <= MAX_DEGREE; n += 1) {
    roots[m][n][0] = Math.sqrt((n - 1) * (n - 1) - square)
    roots[m][n][1] = 1 / Math.sqrt(n * n - square)
  }
}

/** Decimal years since the 2025.0 model epoch. */
const yearsSince2025 = (date: Date): number =>
  (date.valueOf() / 86_400_000 + 2_440_587.5 - 2_460_676.5) / 365.25

export interface MagneticField {
  /** Degrees east of true north (positive = east). */
  declination: number
  /** Field inclination below the horizon. */
  inclination: number
  /** Total intensity, nT. */
  intensity: number
  north: number
  east: number
  vertical: number
  horizontal: number
}

const zero = (): number[][] =>
  Array.from({ length: 13 }, () => Array(13).fill(0))

/** WMM2025 field at WGS84 longitude/latitude and altitude in km. */
export function magneticField(
  lon: number,
  lat: number,
  altitude = 0,
  date = new Date(),
): MagneticField {
  const p = zero()
  const dp = zero()
  const sinLat = Math.sin(lat * DEG)
  const cosLat = Math.cos(lat * DEG)
  const sr = Math.hypot(A * cosLat, B * sinLat)
  const theta = Math.atan2(
    cosLat * (altitude * sr + A * A),
    sinLat * (altitude * sr + B * B),
  )
  const r = Math.sqrt(
    altitude * altitude +
      2 * altitude * sr +
      (A ** 4 - (A ** 4 - B ** 4) * sinLat ** 2) /
        (A * A - (A * A - B * B) * sinLat ** 2),
  )
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const invS = 1 / (s === 0 ? 1e-8 : s)

  p[0][0] = 1
  p[1][1] = s
  p[1][0] = c
  dp[1][0] = -s
  dp[1][1] = c
  for (let n = 2; n <= MAX_DEGREE; n += 1) {
    p[n][n] = p[n - 1][n - 1] * s * root[n]
    dp[n][n] = (dp[n - 1][n - 1] * s + p[n - 1][n - 1] * c) * root[n]
  }
  for (let m = 0; m <= MAX_DEGREE; m += 1) {
    for (let n = Math.max(m + 1, 2); n <= MAX_DEGREE; n += 1) {
      p[n][m] =
        (p[n - 1][m] * c * (2 * n - 1) - p[n - 2][m] * roots[m][n][0]) *
        roots[m][n][1]
      dp[n][m] =
        ((dp[n - 1][m] * c - p[n - 1][m] * s) * (2 * n - 1) -
          dp[n - 2][m] * roots[m][n][0]) *
        roots[m][n][1]
    }
  }

  const years = yearsSince2025(date)
  const sinM = Array(13).fill(0)
  const cosM = Array(13).fill(0)
  for (let m = 0; m <= MAX_DEGREE; m += 1) {
    sinM[m] = Math.sin(m * lon * DEG)
    cosM[m] = Math.cos(m * lon * DEG)
  }

  let br = 0
  let bTheta = 0
  let bPhi = 0
  let ratio = R0 / r
  const ratio0 = ratio
  for (let n = 1; n <= MAX_DEGREE; n += 1) {
    let c1 = 0
    let c2 = 0
    let c3 = 0
    for (let m = 0; m <= n; m += 1) {
      const g = G[n][m] + years * G_DOT[n][m]
      const h = H[n][m] + years * H_DOT[n][m]
      const harmonic = g * cosM[m] + h * sinM[m]
      c1 += harmonic * p[n][m]
      c2 += harmonic * dp[n][m]
      c3 += m * (g * sinM[m] - h * cosM[m]) * p[n][m]
    }
    ratio *= ratio0
    br += (n + 1) * c1 * ratio
    bTheta -= c2 * ratio
    bPhi += c3 * ratio * invS
  }

  const psi = theta - (Math.PI / 2 - lat * DEG)
  const sinPsi = Math.sin(psi)
  const cosPsi = Math.cos(psi)
  const north = -bTheta * cosPsi - br * sinPsi
  const east = bPhi
  const vertical = bTheta * sinPsi - br * cosPsi
  const horizontal = Math.hypot(north, east)
  return {
    declination: Math.atan2(east, north) * RAD,
    inclination:
      Math.atan2(vertical, horizontal) * RAD,
    intensity: Math.hypot(north, east, vertical),
    north,
    east,
    vertical,
    horizontal,
  }
}
