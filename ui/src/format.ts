import { getLocale, tr } from './locale.ts'

const MAX_LAT = 85.05112877980659

export type Bounds = [[number, number], [number, number]]

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

const tileCountAtZoom = (bounds: Bounds, zoom: number): number => {
  const [[west, south], [east, north]] = bounds
  const n = 2 ** zoom
  const x0 = clamp(Math.floor(((west + 180) / 360) * n), 0, n - 1)
  const x1 = clamp(Math.floor(((east + 180) / 360) * n), 0, n - 1)
  const northRad = (clamp(north, -MAX_LAT, MAX_LAT) * Math.PI) / 180
  const southRad = (clamp(south, -MAX_LAT, MAX_LAT) * Math.PI) / 180
  const y0 = clamp(
    Math.floor(
      ((1 -
        Math.log(Math.tan(northRad) + 1 / Math.cos(northRad)) / Math.PI) /
        2) *
        n,
    ),
    0,
    n - 1,
  )
  const y1 = clamp(
    Math.floor(
      ((1 -
        Math.log(Math.tan(southRad) + 1 / Math.cos(southRad)) / Math.PI) /
        2) *
        n,
    ),
    0,
    n - 1,
  )
  return (Math.abs(x1 - x0) + 1) * (Math.abs(y1 - y0) + 1)
}

export interface DownloadEstimate {
  tiles: number
  bytes: number
  seconds: number
}

export const estimateDownload = (
  bounds: Bounds | null,
  minZoom: number,
  maxZoom: number,
  averageTileBytes = 28_000,
  bytesPerSecond = 2_500_000,
): DownloadEstimate => {
  if (!bounds) return { tiles: 0, bytes: 0, seconds: 0 }
  let tiles = 0
  for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) {
    tiles += tileCountAtZoom(bounds, zoom)
  }
  const bytes = tiles * averageTileBytes
  return { tiles, bytes, seconds: bytes / bytesPerSecond }
}

const numberFormats = {
  ru: new Intl.NumberFormat('ru-RU'),
  en: new Intl.NumberFormat('en-US'),
  de: new Intl.NumberFormat('de-DE'),
  fr: new Intl.NumberFormat('fr-FR'),
  es: new Intl.NumberFormat('es-ES'),
}

export const formatCount = (value: number) =>
  numberFormats[getLocale()].format(value)

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${Math.round(bytes)} ${tr('Б', 'B')}`
  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(1)} ${tr('КБ', 'KB')}`
  }
  if (bytes < 1024 ** 3) {
    return `${(bytes / 1024 ** 2).toFixed(1)} ${tr('МБ', 'MB')}`
  }
  return `${(bytes / 1024 ** 3).toFixed(2)} ${tr('ГБ', 'GB')}`
}

export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${Math.ceil(seconds)} ${tr('с', 's')}`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} ${tr('мин', 'min')}`
  const hours = Math.floor(minutes / 60)
  return `${hours} ${tr('ч', 'h')} ${minutes % 60} ${tr('мин', 'min')}`
}

export const formatCoord = (value: number, digits = 5) =>
  value.toFixed(digits)

export const formatBounds = (bounds: Bounds | null): string => {
  if (!bounds) return '—'
  const [[west, south], [east, north]] = bounds
  return `${formatCoord(west, 3)}, ${formatCoord(south, 3)} — ${formatCoord(east, 3)}, ${formatCoord(north, 3)}`
}
