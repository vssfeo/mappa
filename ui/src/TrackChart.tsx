/** Elevation and speed chart for a GPX track. */

import { useMemo, type KeyboardEvent, type PointerEvent } from 'react'
import { formatDuration, formatCount } from './format.ts'
import { useText } from './i18n.ts'
import {
  downsampleSamples,
  sampleAt,
  type TrackModel,
  type TrackSample,
} from './trackProfile.ts'

const WIDTH = 320
const HEIGHT = 104
const PAD = 8
const PLOT = HEIGHT - PAD * 2

interface TrackChartProps {
  model: TrackModel
  progress: number
  onSeek: (progress: number) => void
}

const speedLabel = (speed: number | null): string =>
  speed === null ? '—' : `${formatCount(Math.round(speed * 3.6))} km/h`

const elevationLabel = (elevation: number | null): string =>
  elevation === null ? '—' : `${formatCount(Math.round(elevation))} m`

function linePath(
  samples: TrackSample[],
  xOf: (sample: TrackSample) => number,
  yOf: (sample: TrackSample) => number,
  valueOf: (sample: TrackSample) => number | null,
): { line: string; first: TrackSample | null; last: TrackSample | null } {
  let line = ''
  let open = false
  let first: TrackSample | null = null
  let last: TrackSample | null = null
  for (const sample of samples) {
    if (valueOf(sample) === null) {
      open = false
      continue
    }
    line += `${open ? 'L' : 'M'}${xOf(sample).toFixed(2)} ${yOf(sample).toFixed(2)}`
    if (!first) first = sample
    last = sample
    open = true
  }
  return { line, first, last }
}

export function TrackChart({ model, progress, onSeek }: TrackChartProps) {
  const tx = useText()
  const { samples, stats, minElevation, maxElevation } = model
  const visible = useMemo(() => downsampleSamples(samples), [samples])
  const current = sampleAt(model, progress)
  const total = stats.distance
  const xOf = (sample: TrackSample) =>
    total > 0 ? PAD + (sample.distance / total) * (WIDTH - PAD * 2) : PAD
  const elevationY = (sample: TrackSample) => {
    const elevation = sample.elevation ?? 0
    const range = (maxElevation ?? 0) - (minElevation ?? 0)
    if (range <= 0) return PAD + PLOT / 2
    return HEIGHT - PAD - ((elevation - (minElevation ?? 0)) / range) * PLOT
  }
  const speedY = (sample: TrackSample) =>
    stats.maxSpeed > 0
      ? HEIGHT - PAD - ((sample.speed ?? 0) / stats.maxSpeed) * PLOT
      : HEIGHT - PAD

  const elevation = linePath(visible, xOf, elevationY, (sample) => sample.elevation)
  const speed = linePath(visible, xOf, speedY, (sample) => sample.speed)
  const area =
    elevation.first && elevation.last
      ? `${elevation.line}L${xOf(elevation.last).toFixed(2)} ${HEIGHT - PAD}` +
        `L${xOf(elevation.first).toFixed(2)} ${HEIGHT - PAD}Z`
      : ''
  const cursor = current ? xOf(current) : 0

  const seekAt = (clientX: number, element: Element) => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0) return
    onSeek(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)))
  }

  const pointerDown = (event: PointerEvent<SVGSVGElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    seekAt(event.clientX, event.currentTarget)
  }

  const pointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (event.buttons !== 1) return
    seekAt(event.clientX, event.currentTarget)
  }

  const keyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const step = event.shiftKey ? 0.1 : 0.01
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onSeek(Math.max(0, progress - step))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onSeek(Math.min(1, progress + step))
    } else if (event.key === 'Home') {
      event.preventDefault()
      onSeek(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      onSeek(1)
    }
  }

  return (
    <div className="track-profile">
      <div className="track-profile-readout">
        {stats.hasElevation && (
          <span className="track-profile-key is-elevation">
            {tx('Высота', 'Elevation')} {elevationLabel(current?.elevation ?? null)}
          </span>
        )}
        {stats.hasTime && (
          <span className="track-profile-key is-speed">
            {tx('Скорость', 'Speed')} {speedLabel(current?.speed ?? null)}
          </span>
        )}
      </div>
      <svg
        className="track-profile-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="slider"
        tabIndex={0}
        aria-label={tx('Профиль высоты и скорости', 'Elevation and speed profile')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        aria-valuetext={`${Math.round(progress * 100)}%`}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onKeyDown={keyDown}
      >
        <line
          className="track-profile-baseline"
          x1={PAD}
          y1={HEIGHT - PAD}
          x2={WIDTH - PAD}
          y2={HEIGHT - PAD}
        />
        {area && <path className="track-profile-area" d={area} />}
        {elevation.line && (
          <path className="track-profile-elevation" d={elevation.line} />
        )}
        {speed.line && (
          <path className="track-profile-speed" d={speed.line} />
        )}
        <line
          className="track-profile-progress"
          x1={cursor}
          y1={PAD}
          x2={cursor}
          y2={HEIGHT - PAD}
        />
        {current?.elevation != null && (
          <circle
            className="track-profile-dot is-elevation"
            cx={cursor}
            cy={elevationY(current)}
            r={2.6}
          />
        )}
        {current?.speed != null && (
          <circle
            className="track-profile-dot is-speed"
            cx={cursor}
            cy={speedY(current)}
            r={2.2}
          />
        )}
      </svg>
      <div className="track-profile-stats">
        {stats.hasElevation && (
          <>
            <span>
              ↑ {formatCount(Math.round(stats.ascent))} m · ↓{' '}
              {formatCount(Math.round(stats.descent))} m
            </span>
            <span>
              {elevationLabel(minElevation)}–{elevationLabel(maxElevation)}
            </span>
          </>
        )}
        {stats.duration !== null && (
          <span>{formatDuration(stats.duration)}</span>
        )}
        {stats.maxSpeed > 0 && (
          <span>
            {tx('макс', 'max')} {speedLabel(stats.maxSpeed)}
          </span>
        )}
      </div>
    </div>
  )
}
