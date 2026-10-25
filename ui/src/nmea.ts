/**
 * NMEA 0183 parsing and a deterministic GGA/RMC/VTG/GSA simulator.
 *
 * The simulator emits one complete cycle per second and runs through the same
 * parser as a real receiver would, so a hardware stream can be added later
 * without changing the GPS store or the recorder.
 */

import type { GpsFix } from './gps.ts'
import { destination, type LonLat } from './geo.ts'

/** One knot in metres per second. */
export const NMEA_KNOTS_TO_MPS = 0.514444
/** Radius of the simulated circular route. */
export const NMEA_SIM_RADIUS = 600

interface Sentence {
  talker: string
  type: string
  fields: string[]
}

interface NmeaTime {
  hour: number
  minute: number
  second: number
  millisecond: number
}

interface NmeaDate {
  year: number
  month: number
  day: number
}

/** XOR checksum of the body between `$` and `*`. */
export function nmeaChecksum(body: string): number {
  let checksum = 0
  for (let index = 0; index < body.length; index += 1) {
    checksum ^= body.charCodeAt(index)
  }
  return checksum
}

/** Wraps a sentence body in `$…*HH`. */
export function formatNmea(body: string): string {
  return `$${body}*${nmeaChecksum(body)
    .toString(16)
    .toUpperCase()
    .padStart(2, '0')}`
}

/**
 * Parses one sentence. A missing checksum is accepted for compatibility with
 * hand-written logs; a present checksum must match.
 */
function parseSentence(line: string): Sentence | null {
  const text = line.trim()
  if (!text.startsWith('$')) return null
  const star = text.lastIndexOf('*')
  let body = text.slice(1)
  if (star >= 0) {
    body = text.slice(1, star)
    const expected = Number.parseInt(text.slice(star + 1, star + 3), 16)
    if (!Number.isFinite(expected) || expected !== nmeaChecksum(body)) {
      return null
    }
  }
  const fields = body.split(',')
  const address = fields.shift() ?? ''
  if (address.length < 5) return null
  return {
    talker: address.slice(0, 2).toUpperCase(),
    type: address.slice(2).toUpperCase(),
    fields,
  }
}

const number = (value: string | undefined): number | null => {
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function coordinate(
  value: string | undefined,
  hemisphere: string | undefined,
  latitude: boolean,
): number | null {
  const raw = number(value)
  if (raw === null || raw < 0) return null
  const degrees = Math.floor(raw / 100)
  const minutes = raw - degrees * 100
  if (minutes < 0 || minutes >= 60) return null
  if (degrees > (latitude ? 90 : 180)) return null
  const direction = hemisphere?.toUpperCase()
  if (
    (latitude && direction !== 'N' && direction !== 'S') ||
    (!latitude && direction !== 'E' && direction !== 'W')
  ) {
    return null
  }
  const sign = direction === 'S' || direction === 'W' ? -1 : 1
  return sign * (degrees + minutes / 60)
}

function parseTime(value: string | undefined): NmeaTime | null {
  const raw = number(value)
  if (raw === null || raw < 0 || raw >= 240_000) return null
  const hour = Math.floor(raw / 10_000)
  const minute = Math.floor((raw - hour * 10_000) / 100)
  const second = raw - hour * 10_000 - minute * 100
  if (hour > 23 || minute > 59 || second >= 60) return null
  return {
    hour,
    minute,
    second,
    millisecond: Math.round((second - Math.floor(second)) * 1000),
  }
}

function parseDate(value: string | undefined): NmeaDate | null {
  if (!value || !/^\d{6}$/.test(value)) return null
  const day = Number(value.slice(0, 2))
  const month = Number(value.slice(2, 4))
  const shortYear = Number(value.slice(4, 6))
  // NMEA two-digit years follow the 1980–2079 convention.
  const year = shortYear >= 80 ? 1900 + shortYear : 2000 + shortYear
  const check = new Date(Date.UTC(year, month - 1, day))
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null
  }
  return { year, month, day }
}

/** Accumulates GGA/RMC/VTG/GSA sentences into one GPS fix. */
export class NmeaParser {
  private lat: number | null = null
  private lon: number | null = null
  private altitude: number | null = null
  private speed: number | null = null
  private heading: number | null = null
  private hdop: number | null = null
  private satellites: number | null = null
  private quality: number | null = null
  private time: NmeaTime | null = null
  private date: NmeaDate | null = null
  private valid = true
  lastTalker: string | null = null

  /** Feeds one sentence; returns false for bad checksums/unsupported types. */
  push(line: string): boolean {
    const sentence = parseSentence(line)
    if (!sentence) return false
    const { fields } = sentence
    switch (sentence.type) {
      case 'GGA': {
        const time = parseTime(fields[0])
        if (time) this.time = time
        const lat = coordinate(fields[1], fields[2], true)
        const lon = coordinate(fields[3], fields[4], false)
        if (lat !== null && lon !== null) {
          this.lat = lat
          this.lon = lon
        }
        const quality = number(fields[5])
        if (quality !== null) {
          this.quality = quality
          this.valid = quality !== 0
        }
        const satellites = number(fields[6])
        if (satellites !== null) this.satellites = Math.round(satellites)
        const hdop = number(fields[7])
        if (hdop !== null) this.hdop = hdop
        const altitude = number(fields[8])
        if (altitude !== null) this.altitude = altitude
        this.lastTalker = sentence.talker
        return true
      }
      case 'RMC': {
        const time = parseTime(fields[0])
        if (time) this.time = time
        const status = fields[1]?.toUpperCase()
        if (status === 'V') this.valid = false
        else if (status === 'A') this.valid = true
        const lat = coordinate(fields[2], fields[3], true)
        const lon = coordinate(fields[4], fields[5], false)
        if (lat !== null && lon !== null) {
          this.lat = lat
          this.lon = lon
        }
        const speed = number(fields[6])
        if (speed !== null) this.speed = speed * NMEA_KNOTS_TO_MPS
        const heading = number(fields[7])
        if (heading !== null) this.heading = ((heading % 360) + 360) % 360
        const date = parseDate(fields[8])
        if (date) this.date = date
        this.lastTalker = sentence.talker
        return true
      }
      case 'VTG': {
        const heading = number(fields[0])
        if (heading !== null) this.heading = ((heading % 360) + 360) % 360
        const kilometres = number(fields[6])
        if (kilometres !== null) {
          this.speed = kilometres / 3.6
        } else {
          const knots = number(fields[4])
          if (knots !== null) this.speed = knots * NMEA_KNOTS_TO_MPS
        }
        this.lastTalker = sentence.talker
        return true
      }
      case 'GSA': {
        const hdop = number(fields[15])
        if (hdop !== null) this.hdop = hdop
        this.lastTalker = sentence.talker
        return true
      }
      default:
        return false
    }
  }

  /** Current fix, or null until position and time are known. */
  fix(): GpsFix | null {
    if (!this.valid || this.lat === null || this.lon === null) return null
    const time = this.time
    if (!time) return null
    const now = new Date()
    const date =
      this.date ??
      {
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 1,
        day: now.getUTCDate(),
      }
    const timestamp = Date.UTC(
      date.year,
      date.month - 1,
      date.day,
      time.hour,
      time.minute,
      Math.floor(time.second),
      time.millisecond,
    )
    const baseAccuracy = this.quality === 4 ? 2.5 : 5
    return {
      lon: this.lon,
      lat: this.lat,
      accuracy:
        this.hdop === null
          ? 10
          : Math.max(0.5, this.hdop * baseAccuracy),
      altitude: this.altitude,
      altitudeAccuracy: null,
      speed: this.speed,
      heading: this.heading,
      timestamp,
      source: 'nmea',
      satellites: this.satellites,
      hdop: this.hdop,
      quality: this.quality,
    }
  }
}

const pad = (value: number, width = 2): string =>
  String(Math.floor(value)).padStart(width, '0')

function encodeCoordinate(
  value: number,
  latitude: boolean,
): [coordinate: string, hemisphere: string] {
  const hemisphere = latitude
    ? value >= 0
      ? 'N'
      : 'S'
    : value >= 0
      ? 'E'
      : 'W'
  const absolute = Math.abs(value)
  const degrees = Math.floor(absolute)
  const minutes = (absolute - degrees) * 60
  const width = latitude ? 2 : 3
  return [
    `${pad(degrees, width)}${minutes.toFixed(4).padStart(7, '0')}`,
    hemisphere,
  ]
}

function encodeTime(date: Date): string {
  const centiseconds = Math.floor(date.getUTCMilliseconds() / 10)
  return `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(
    date.getUTCSeconds(),
  )}.${pad(centiseconds)}`
}

function encodeDate(date: Date): string {
  return `${pad(date.getUTCDate())}${pad(
    date.getUTCMonth() + 1,
  )}${pad(date.getUTCFullYear() % 100)}`
}

/** One simulator tick: sentences plus the fix they decode into. */
export interface NmeaSimulationTick {
  sentences: string[]
  fix: GpsFix | null
}

/**
 * Moves around a circle of `radius` metres and emits a complete NMEA cycle.
 * Speed is in metres per second; time advances between `step(now)` calls.
 */
export class NmeaSimulator {
  private readonly start: LonLat
  private readonly radius: number
  private speed: number
  private angle = 0
  private lastAt = 0

  constructor(start: LonLat, speed = 5, radius = NMEA_SIM_RADIUS) {
    this.start = start
    this.speed = Math.max(0, Math.min(100, speed))
    this.radius = Math.max(50, radius)
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0, Math.min(100, speed))
  }

  step(now = Date.now()): NmeaSimulationTick {
    const delta =
      this.lastAt === 0
        ? 1
        : Math.min(5, Math.max(0.1, (now - this.lastAt) / 1000))
    this.lastAt = now
    this.angle += (this.speed * delta) / this.radius
    const bearing = ((this.angle * 180) / Math.PI) % 360
    const position = destination(this.start, bearing, this.radius)
    const heading = (bearing + 90) % 360
    const date = new Date(now)
    const time = encodeTime(date)
    const day = encodeDate(date)
    const [lat, ns] = encodeCoordinate(position[1], true)
    const [lon, ew] = encodeCoordinate(position[0], false)
    const altitude = 160 + 30 * Math.sin(this.angle * 3)
    const hdop = 0.8 + 0.2 * Math.abs(Math.sin(now / 9000))
    const satellites = 12
    const knots = this.speed / NMEA_KNOTS_TO_MPS
    const sentences = [
      formatNmea(
        `GPGGA,${time},${lat},${ns},${lon},${ew},1,${satellites},${hdop.toFixed(
          1,
        )},${altitude.toFixed(1)},M,14.0,M,,`,
      ),
      formatNmea(
        `GPRMC,${time},A,${lat},${ns},${lon},${ew},${knots.toFixed(
          2,
        )},${heading.toFixed(1)},${day},,,A`,
      ),
      formatNmea(
        `GPVTG,${heading.toFixed(1)},T,,M,${knots.toFixed(2)},N,${(
          this.speed * 3.6
        ).toFixed(1)},K,A`,
      ),
      formatNmea(
        `GPGSA,A,3,01,02,03,04,05,06,07,08,09,10,11,12,1.4,${hdop.toFixed(
          1,
        )},1.0`,
      ),
    ]
    const parser = new NmeaParser()
    for (const sentence of sentences) parser.push(sentence)
    return { sentences, fix: parser.fix() }
  }
}
