/** Distance-aligned elevation and speed samples for an imported track. */

import { distance, type LonLat } from './geo.ts'
import type { TrackProfile } from './features.ts'

/** Ground tracks above this speed are treated as GPS jumps, not motion. */
export const MAX_PLAUSIBLE_SPEED = 150

export interface TrackSample {
  /** Metres travelled from the first vertex. */
  distance: number
  elevation: number | null
  /** Milliseconds since epoch, parsed from the GPX `<time>`. */
  time: number | null
  /** Metres per second over the segment ending at this sample. */
  speed: number | null
}

export interface TrackStats {
  distance: number
  ascent: number
  descent: number
  /** Seconds between the first and last timestamp. */
  duration: number | null
  maxSpeed: number
  hasElevation: boolean
  hasTime: boolean
}

export interface TrackModel {
  samples: TrackSample[]
  stats: TrackStats
  minElevation: number | null
  maxElevation: number | null
}

const finiteElevation = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const parseTime = (value: unknown): number | null => {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Builds a track model; missing profile entries stay null and create gaps. */
export function buildTrackProfile(
  coordinates: LonLat[],
  profile?: TrackProfile,
): TrackModel {
  const samples: TrackSample[] = []
  let cumulative = 0
  let previous: TrackSample | null = null
  for (let index = 0; index < coordinates.length; index += 1) {
    if (index > 0) {
      const segment = distance(coordinates[index - 1], coordinates[index])
      cumulative += segment
      const previousTime: number | null = previous?.time ?? null
      const time = parseTime(profile?.times[index])
      let speed: number | null = null
      if (previousTime !== null && time !== null) {
        const seconds: number = (time - previousTime) / 1000
        const value: number | null = seconds > 0 ? segment / seconds : null
        speed =
          value !== null && value <= MAX_PLAUSIBLE_SPEED ? value : null
      }
      previous = {
        distance: cumulative,
        elevation: finiteElevation(profile?.elevations[index]),
        time,
        speed,
      }
    } else {
      previous = {
        distance: 0,
        elevation: finiteElevation(profile?.elevations[0]),
        time: parseTime(profile?.times[0]),
        speed: null,
      }
    }
    samples.push(previous)
  }

  let ascent = 0
  let descent = 0
  let minElevation: number | null = null
  let maxElevation: number | null = null
  let elevationCount = 0
  let maxSpeed = 0
  for (let index = 0; index < samples.length; index += 1) {
    const elevation = samples[index].elevation
    if (elevation !== null) {
      elevationCount += 1
      minElevation =
        minElevation === null ? elevation : Math.min(minElevation, elevation)
      maxElevation =
        maxElevation === null ? elevation : Math.max(maxElevation, elevation)
      const previousElevation = samples[index - 1]?.elevation ?? null
      if (previousElevation !== null) {
        const delta = elevation - previousElevation
        if (delta > 0) ascent += delta
        if (delta < 0) descent -= delta
      }
    }
    const speed = samples[index].speed
    if (speed !== null) maxSpeed = Math.max(maxSpeed, speed)
  }

  const timed = samples.filter(
    (sample): sample is TrackSample & { time: number } => sample.time !== null,
  )
  const duration =
    timed.length >= 2
      ? Math.max(0, (timed[timed.length - 1].time - timed[0].time) / 1000)
      : null

  return {
    samples,
    stats: {
      distance: cumulative,
      ascent,
      descent,
      duration,
      maxSpeed,
      hasElevation: elevationCount >= 2,
      hasTime: timed.length >= 2,
    },
    minElevation,
    maxElevation,
  }
}

const clampFraction = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0

const interpolate = (
  left: number | null,
  right: number | null,
  ratio: number,
): number | null => {
  if (left === null || right === null) return ratio < 0.5 ? left : right
  return left + (right - left) * ratio
}

/** Returns interpolated elevation/speed at a fraction of the track length. */
export function sampleAt(
  model: TrackModel,
  fraction: number,
): TrackSample | null {
  const samples = model.samples
  if (samples.length === 0) return null
  const target = clampFraction(fraction) * model.stats.distance
  let low = 0
  let high = samples.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (samples[middle].distance < target) low = middle + 1
    else high = middle
  }
  const right = samples[low]
  if (low === 0) return { ...right, distance: target }
  const left = samples[low - 1]
  const span = right.distance - left.distance
  const ratio = span > 0 ? (target - left.distance) / span : 0
  return {
    distance: target,
    elevation: interpolate(left.elevation, right.elevation, ratio),
    time: interpolate(left.time, right.time, ratio),
    speed: interpolate(left.speed, right.speed, ratio),
  }
}

/** Keeps SVG paths bounded while preserving the first and last vertex. */
export function downsampleSamples(
  samples: TrackSample[],
  limit = 320,
): TrackSample[] {
  if (samples.length <= limit || limit < 2) return samples
  const step = (samples.length - 1) / (limit - 1)
  const result: TrackSample[] = []
  for (let index = 0; index < limit; index += 1) {
    const sample = samples[Math.round(index * step)]
    if (result[result.length - 1] !== sample) result.push(sample)
  }
  return result
}
