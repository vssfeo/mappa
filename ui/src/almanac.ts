/** Offline sun and moon almanac (NOAA solar equations, synodic moon phase). */

const RAD = Math.PI / 180
const SYNODIC_DAYS = 29.530588853
const NEW_MOON_2000 = Date.UTC(2000, 0, 6, 18, 14)

export type PolarState = 'day' | 'night' | null

export interface SolarDay {
  sunrise: Date | null
  sunset: Date | null
  solarNoon: Date
  civilDawn: Date | null
  civilDusk: Date | null
  nauticalDawn: Date | null
  nauticalDusk: Date | null
  astronomicalDawn: Date | null
  astronomicalDusk: Date | null
  /** Minutes of daylight, or null when the sun never rises/sets. */
  dayLengthMinutes: number | null
  polar: PolarState
}

export type MoonPhaseName =
  | 'new'
  | 'waxing-crescent'
  | 'first-quarter'
  | 'waxing-gibbous'
  | 'full'
  | 'waning-gibbous'
  | 'last-quarter'
  | 'waning-crescent'

export interface MoonInfo {
  /** 0 = new, 0.5 = full. */
  phase: number
  /** 0..1 illuminated fraction. */
  illumination: number
  ageDays: number
  name: MoonPhaseName
}

const dayOfYear = (date: Date): number => {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0)
  return (date.getTime() - start) / 86_400_000
}

const solarParameters = (date: Date): { declination: number; equationOfTime: number } => {
  const noon = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    12,
  )
  const gamma = ((2 * Math.PI) / 365) * (dayOfYear(new Date(noon)) - 1)
  const equationOfTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma))
  const declination =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma)
  return { declination, equationOfTime }
}

const dateAtMinutes = (date: Date, minutes: number): Date =>
  new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      0,
      0,
      0,
      0,
    ) +
      minutes * 60_000,
  )

interface HourAngle {
  rise: Date | null
  set: Date | null
  /** True when the sun stays above the altitude all day. */
  alwaysUp: boolean
  /** True when the sun stays below the altitude all day. */
  alwaysDown: boolean
}

const hourAngle = (
  date: Date,
  lat: number,
  lon: number,
  altitude: number,
  declination: number,
  equationOfTime: number,
): HourAngle => {
  const noonMinutes = 720 - 4 * lon - equationOfTime
  const cosH =
    (Math.sin(altitude * RAD) - Math.sin(lat * RAD) * Math.sin(declination)) /
    (Math.cos(lat * RAD) * Math.cos(declination))
  if (cosH >= 1) {
    return { rise: null, set: null, alwaysUp: false, alwaysDown: true }
  }
  if (cosH <= -1) {
    return { rise: null, set: null, alwaysUp: true, alwaysDown: false }
  }
  const h = Math.acos(cosH) / RAD
  return {
    rise: dateAtMinutes(date, noonMinutes - 4 * h),
    set: dateAtMinutes(date, noonMinutes + 4 * h),
    alwaysUp: false,
    alwaysDown: false,
  }
}

/** Sunrise, sunset, twilights and daylight for a UTC calendar day. */
export function solarDay(date: Date, lat: number, lon: number): SolarDay {
  const { declination, equationOfTime } = solarParameters(date)
  const noonMinutes = 720 - 4 * lon - equationOfTime
  const sun = hourAngle(date, lat, lon, -0.833, declination, equationOfTime)
  const civil = hourAngle(date, lat, lon, -6, declination, equationOfTime)
  const nautical = hourAngle(date, lat, lon, -12, declination, equationOfTime)
  const astronomical = hourAngle(date, lat, lon, -18, declination, equationOfTime)
  const dayLengthMinutes =
    sun.rise && sun.set
      ? Math.round((sun.set.getTime() - sun.rise.getTime()) / 60_000)
      : null
  return {
    sunrise: sun.rise,
    sunset: sun.set,
    solarNoon: dateAtMinutes(date, noonMinutes),
    civilDawn: civil.rise,
    civilDusk: civil.set,
    nauticalDawn: nautical.rise,
    nauticalDusk: nautical.set,
    astronomicalDawn: astronomical.rise,
    astronomicalDusk: astronomical.set,
    dayLengthMinutes,
    polar: sun.alwaysUp ? 'day' : sun.alwaysDown ? 'night' : null,
  }
}

/** Moon phase for an instant. */
export function moonPhase(date: Date): MoonInfo {
  const days = (date.getTime() - NEW_MOON_2000) / 86_400_000
  const ageDays = ((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS
  const phase = ageDays / SYNODIC_DAYS
  const illumination = (1 - Math.cos(2 * Math.PI * phase)) / 2
  const fromNew = Math.min(phase, 1 - phase)
  const name: MoonPhaseName =
    fromNew < 0.03
      ? 'new'
      : phase < 0.22
        ? 'waxing-crescent'
        : phase < 0.28
          ? 'first-quarter'
          : phase < 0.47
            ? 'waxing-gibbous'
            : phase < 0.53
              ? 'full'
              : phase < 0.72
                ? 'waning-gibbous'
                : phase < 0.78
                  ? 'last-quarter'
                  : 'waning-crescent'
  return { phase, illumination, ageDays, name }
}
