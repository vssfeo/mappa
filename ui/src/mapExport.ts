/**
 * Map snapshots: PNG + world file, GeoTIFF and PDF.
 *
 * The WebGL canvas is captured inside a `render` callback (the drawing buffer
 * is not preserved), then grid, attribution and a scale bar are composited on
 * a 2D canvas. Georeferencing is Web Mercator, matching MapLibre's projection.
 */

import { save } from '@tauri-apps/plugin-dialog'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { getLocale, tr } from './locale.ts'
import {
  exportGeoTiff,
  isNative,
  writeBinaryFile,
  type GeoTiffGeoreference,
} from './native.ts'
import { buildPdf } from './pdf.ts'
import { PROVIDERS } from './providers.ts'
import { useAppStore } from './store.ts'

export type MapExportFormat = 'png' | 'tiff' | 'pdf'

export interface MapExportOptions {
  grid: boolean
  legend: boolean
}

export interface MapExportResult {
  image: string
  worldFile: string | null
}

const MERCATOR_RADIUS = 6_378_137

const mercatorY = (lat: number): number =>
  Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * MERCATOR_RADIUS

const mercatorX = (lon: number): number =>
  (lon * Math.PI * MERCATOR_RADIUS) / 180

const requireNative = () => {
  if (!isNative) {
    throw new Error(tr('Экспорт доступен в нативном приложении', 'Export is available in the native app'))
  }
}

function niceStep(span: number, target: number): number {
  const raw = span / target
  if (!Number.isFinite(raw) || raw <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(raw))
  for (const multiplier of [1, 2, 5, 10]) {
    if (multiplier * power >= raw) return multiplier * power
  }
  return 10 * power
}

function capture(map: MapLibreMap): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const source = map.getCanvas()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try {
        const canvas = document.createElement('canvas')
        canvas.width = source.width
        canvas.height = source.height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('2D canvas is unavailable')
        context.drawImage(source, 0, 0)
        resolve(canvas)
      } catch (error) {
        reject(error)
      }
    }
    const timeout = setTimeout(finish, 400)
    try {
      map.once('render', finish)
      map.triggerRepaint()
    } catch (error) {
      clearTimeout(timeout)
      reject(error)
    }
  })
}

function georeference(
  map: MapLibreMap,
  canvas: HTMLCanvasElement,
): GeoTiffGeoreference {
  const source = map.getCanvas()
  const width = source.clientWidth || canvas.width
  const height = source.clientHeight || canvas.height
  const northWest = map.unproject([0, 0])
  const southEast = map.unproject([width, height])
  const west = mercatorX(northWest.lng)
  const east = mercatorX(southEast.lng)
  const north = mercatorY(northWest.lat)
  const south = mercatorY(southEast.lat)
  return {
    west,
    north,
    resX: (east - west) / canvas.width,
    resY: (north - south) / canvas.height,
  }
}

function worldFile(geo: GeoTiffGeoreference): string {
  return [
    geo.resX.toFixed(12),
    '0',
    '0',
    (-geo.resY).toFixed(12),
    (geo.west + geo.resX / 2).toFixed(12),
    (geo.north - geo.resY / 2).toFixed(12),
    '',
  ].join('\n')
}

function drawGrid(
  context: CanvasRenderingContext2D,
  map: MapLibreMap,
  ratio: number,
): void {
  const bounds = map.getBounds()
  const west = bounds.getWest()
  const east = bounds.getEast()
  const south = bounds.getSouth()
  const north = bounds.getNorth()
  if (![west, east, south, north].every(Number.isFinite)) return
  const lonStep = niceStep(Math.abs(east - west), 6)
  const latStep = niceStep(Math.abs(north - south), 4)
  const width = context.canvas.width
  const height = context.canvas.height
  const center = map.getCenter()
  context.save()
  context.lineWidth = Math.max(1, ratio)
  context.font = `${11 * ratio}px system-ui, sans-serif`
  context.textBaseline = 'top'

  const line = (x1: number, y1: number, x2: number, y2: number) => {
    context.strokeStyle = 'rgba(0, 0, 0, 0.45)'
    context.lineWidth = 3 * ratio
    context.beginPath()
    context.moveTo(x1, y1)
    context.lineTo(x2, y2)
    context.stroke()
    context.strokeStyle = 'rgba(255, 255, 255, 0.8)'
    context.lineWidth = Math.max(0.8, ratio)
    context.beginPath()
    context.moveTo(x1, y1)
    context.lineTo(x2, y2)
    context.stroke()
  }
  const label = (text: string, x: number, y: number) => {
    context.strokeStyle = 'rgba(0, 0, 0, 0.75)'
    context.lineWidth = 3 * ratio
    context.strokeText(text, x, y)
    context.fillStyle = '#ffffff'
    context.fillText(text, x, y)
  }

  for (
    let lon = Math.ceil(west / lonStep) * lonStep;
    lon <= east;
    lon += lonStep
  ) {
    const x = map.project([lon, center.lat]).x * ratio
    line(x, 0, x, height)
    label(`${lon.toFixed(lonStep < 1 ? 2 : 1)}°`, x + 4 * ratio, 6 * ratio)
  }
  for (
    let lat = Math.ceil(south / latStep) * latStep;
    lat <= north;
    lat += latStep
  ) {
    const y = map.project([center.lng, lat]).y * ratio
    line(0, y, width, y)
    label(`${lat.toFixed(latStep < 1 ? 2 : 1)}°`, 6 * ratio, y + 3 * ratio)
  }
  context.restore()
}

function drawLegend(
  context: CanvasRenderingContext2D,
  map: MapLibreMap,
  ratio: number,
): void {
  const state = useAppStore.getState()
  const provider =
    PROVIDERS.find((item) => item.id === state.providerId) ?? PROVIDERS[0]
  const lines = [
    provider.label,
    provider.attribution,
    `z${map.getZoom().toFixed(1)} · EPSG:3857 · ${new Date().toLocaleDateString(getLocale())}`,
  ].filter(Boolean)
  context.save()
  context.font = `${11 * ratio}px system-ui, sans-serif`
  const padding = 8 * ratio
  const lineHeight = 15 * ratio
  const boxWidth =
    Math.max(...lines.map((line) => context.measureText(line).width)) +
    padding * 2
  const boxHeight = lines.length * lineHeight + padding * 2 - 3 * ratio
  const x = 14 * ratio
  const y = context.canvas.height - boxHeight - 14 * ratio
  context.fillStyle = 'rgba(8, 13, 20, 0.78)'
  context.strokeStyle = 'rgba(255, 255, 255, 0.22)'
  context.lineWidth = ratio
  context.beginPath()
  if (typeof context.roundRect === 'function') {
    context.roundRect(x, y, boxWidth, boxHeight, 6 * ratio)
  } else {
    context.rect(x, y, boxWidth, boxHeight)
  }
  context.fill()
  context.stroke()
  context.fillStyle = '#e8eef6'
  context.textBaseline = 'top'
  lines.forEach((line, index) => {
    context.globalAlpha = index === 0 ? 1 : 0.72
    context.fillText(line, x + padding, y + padding + index * lineHeight)
  })
  context.globalAlpha = 1

  // Scale bar in the opposite corner.
  const center = map.getCenter()
  const metersPerCssPixel =
    (156_543.033_928_040_97 * Math.cos((center.lat * Math.PI) / 180)) /
    2 ** map.getZoom()
  const metersPerImagePixel = metersPerCssPixel / ratio
  const target = metersPerImagePixel * 120 * ratio
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(target, 1e-6)))
  const step =
    [1, 2, 5, 10].map((item) => item * magnitude).find((item) => item >= target) ??
    target
  const barWidth = step / metersPerImagePixel
  const barX = context.canvas.width - barWidth - 18 * ratio
  const barY = context.canvas.height - 26 * ratio
  const text =
    step >= 1000 ? `${step / 1000} km` : `${Math.round(step)} ${tr('м', 'm')}`
  context.strokeStyle = 'rgba(0, 0, 0, 0.6)'
  context.lineWidth = 4 * ratio
  context.beginPath()
  context.moveTo(barX, barY)
  context.lineTo(barX + barWidth, barY)
  context.stroke()
  context.strokeStyle = '#ffffff'
  context.lineWidth = 2 * ratio
  context.beginPath()
  context.moveTo(barX, barY - 4 * ratio)
  context.lineTo(barX, barY + 4 * ratio)
  context.moveTo(barX + barWidth, barY - 4 * ratio)
  context.lineTo(barX + barWidth, barY + 4 * ratio)
  context.moveTo(barX, barY)
  context.lineTo(barX + barWidth, barY)
  context.stroke()
  context.font = `${10 * ratio}px system-ui, sans-serif`
  context.fillStyle = '#ffffff'
  context.strokeStyle = 'rgba(0, 0, 0, 0.75)'
  context.lineWidth = 3 * ratio
  context.strokeText(text, barX + barWidth / 2 - 10 * ratio, barY - 16 * ratio)
  context.fillText(text, barX + barWidth / 2 - 10 * ratio, barY - 16 * ratio)
  context.restore()
}

async function compose(
  map: MapLibreMap,
  options: MapExportOptions,
): Promise<{ canvas: HTMLCanvasElement; geo: GeoTiffGeoreference }> {
  const canvas = await capture(map)
  const ratio = canvas.width / (map.getCanvas().clientWidth || canvas.width)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('2D canvas is unavailable')
  if (options.grid) drawGrid(context, map, ratio)
  if (options.legend) drawLegend(context, map, ratio)
  return { canvas, geo: georeference(map, canvas) }
}

const toBlob = (
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas is empty'))),
      type,
      quality,
    )
  })

/** Saves a georeferenced PNG and its `.pgw` world file. */
export async function exportMapPng(
  map: MapLibreMap,
  options: MapExportOptions,
): Promise<MapExportResult | null> {
  requireNative()
  const path = await save({
    title: tr('Экспорт карты в PNG', 'Export the map as PNG'),
    defaultPath: 'mappa-map.png',
    filters: [{ name: 'PNG', extensions: ['png'] }],
  })
  if (typeof path !== 'string' || !path) return null
  const { canvas, geo } = await compose(map, options)
  const blob = await toBlob(canvas, 'image/png')
  await writeBinaryFile(path, await blob.arrayBuffer())
  const world = path.replace(/\.png$/i, '.pgw')
  await writeBinaryFile(world, new TextEncoder().encode(worldFile(geo)))
  return { image: path, worldFile: world }
}

/** Saves a GeoTIFF (EPSG:3857) plus a `.tfw` sidecar. */
export async function exportMapGeoTiff(
  map: MapLibreMap,
  options: MapExportOptions,
): Promise<MapExportResult | null> {
  requireNative()
  const path = await save({
    title: tr('Экспорт карты в GeoTIFF', 'Export the map as GeoTIFF'),
    defaultPath: 'mappa-map.tif',
    filters: [{ name: 'GeoTIFF', extensions: ['tif', 'tiff'] }],
  })
  if (typeof path !== 'string' || !path) return null
  const { canvas, geo } = await compose(map, options)
  const blob = await toBlob(canvas, 'image/png')
  await exportGeoTiff(path, await blob.arrayBuffer(), geo)
  const world = path.replace(/\.tiff?$/i, '.tfw')
  await writeBinaryFile(world, new TextEncoder().encode(worldFile(geo)))
  return { image: path, worldFile: world }
}

/** Saves the composed snapshot as a one-page PDF (A4, JPEG inside). */
export async function exportMapPdf(
  map: MapLibreMap,
  options: MapExportOptions,
): Promise<MapExportResult | null> {
  requireNative()
  const path = await save({
    title: tr('Экспорт карты в PDF', 'Export the map as PDF'),
    defaultPath: 'mappa-map.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (typeof path !== 'string' || !path) return null
  const { canvas } = await compose(map, options)
  const blob = await toBlob(canvas, 'image/jpeg', 0.92)
  const jpeg = new Uint8Array(await blob.arrayBuffer())
  const state = useAppStore.getState()
  const provider =
    PROVIDERS.find((item) => item.id === state.providerId) ?? PROVIDERS[0]
  const date = new Date().toISOString().slice(0, 10)
  const pdf = buildPdf(jpeg, canvas.width, canvas.height, {
    title: `Mappa map - ${provider.label}`,
    footer: `${provider.attribution} | EPSG:3857 | z${map.getZoom().toFixed(1)} | ${date}`,
  })
  await writeBinaryFile(path, pdf)
  return { image: path, worldFile: null }
}
