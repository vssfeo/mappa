/** gpsd JSON reports to the shared GNSS fix model. */

import type { GpsFix } from './gps.ts'

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const firstFinite = (...values: unknown[]): number | null => {
  for (const value of values) {
    const parsed = finite(value)
    if (parsed !== null) return parsed
  }
  return null
}

const timestamp = (value: unknown): number => {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

/**
 * Accumulates SKY metadata and turns TPV reports into fixes.
 *
 * TPV `mode` 0/1 means no position; 2D/3D fixes are accepted. gpsd reports
 * speed in m/s and track in degrees, matching the UI model directly.
 */
export class GpsdParser {
  private satellites: number | null = null
  private hdop: number | null = null

  push(line: string): GpsFix | null {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return null
    }
    if (!record(value) || typeof value.class !== 'string') return null
    if (value.class === 'SKY') {
      this.updateSky(value)
      return null
    }
    if (value.class !== 'TPV') return null
    return this.fix(value)
  }

  private updateSky(value: Record<string, unknown>): void {
    const used = finite(value.uSat)
    if (used !== null) {
      this.satellites = Math.round(used)
    } else if (Array.isArray(value.satellites)) {
      this.satellites = value.satellites.filter(
        (satellite) => record(satellite) && satellite.used === true,
      ).length
    }
    const hdop = finite(value.hdop)
    if (hdop !== null) this.hdop = hdop
  }

  private fix(value: Record<string, unknown>): GpsFix | null {
    const mode = finite(value.mode)
    if (mode === null || mode < 2) return null
    const lat = finite(value.lat)
    const lon = finite(value.lon)
    if (
      lat === null ||
      lon === null ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      return null
    }

    const epx = finite(value.epx)
    const epy = finite(value.epy)
    const accuracy =
      epx === null && epy === null
        ? 10
        : Math.max(
            0.5,
            Math.hypot(Math.max(0, epx ?? 0), Math.max(0, epy ?? 0)),
          )
    const speed = finite(value.speed)
    const track = finite(value.track)
    return {
      lon,
      lat,
      accuracy,
      altitude: firstFinite(value.altMSL, value.altHAE, value.alt),
      altitudeAccuracy: null,
      speed: speed !== null && speed >= 0 ? speed : null,
      heading: track !== null && track >= 0 ? track % 360 : null,
      timestamp: timestamp(value.time),
      source: 'gpsd',
      satellites: this.satellites,
      hdop: this.hdop,
      quality: null,
    }
  }
}
