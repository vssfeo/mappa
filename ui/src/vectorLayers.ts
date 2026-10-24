/**
 * Imported vector layers (GeoJSON, GPX, KML/KMZ) and their attributes.
 *
 * Coordinates are validated and bounded before they reach MapLibre: imported
 * files are untrusted and a malformed ring must not stall the renderer.
 */

import type {
  Feature,
  Geometry,
  LineString,
  Polygon,
  Position,
} from 'geojson'
import type { Bounds } from './format.ts'
import {
  child,
  childText,
  findDescendants,
  nodeText,
  parseXml,
  type XmlNode,
} from './xml.ts'
import { tr } from './locale.ts'

export type VectorFormat = 'geojson' | 'kml' | 'kmz' | 'gpx' | 'shp' | 'gpkg'

export interface VectorStyle {
  color: string
  lineWidth: number
  fillOpacity: number
  pointRadius: number
}

export type VectorFeature = Feature<
  Geometry,
  Record<string, unknown>
>

export interface VectorLayer {
  id: string
  name: string
  format: VectorFormat
  features: VectorFeature[]
  style: VectorStyle
  visible: boolean
  opacity: number
  source: string | null
}

export const MAX_VECTOR_FEATURES = 100_000
export const MAX_VECTOR_POINTS = 2_000_000
export const MAX_PROPERTIES = 64
export const MAX_VECTOR_LAYERS = 64

export const VECTOR_FORMATS: VectorFormat[] = [
  'geojson',
  'kml',
  'kmz',
  'gpx',
  'shp',
  'gpkg',
]

export const VECTOR_COLORS = [
  '#ff7a45',
  '#4cc9f0',
  '#3ddc97',
  '#ffd166',
  '#b892ff',
  '#e76f51',
]

export function vectorLayerId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `vector-${crypto.randomUUID()}`
  }
  return `vector-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

export function defaultVectorStyle(index = 0): VectorStyle {
  return {
    color: VECTOR_COLORS[index % VECTOR_COLORS.length],
    lineWidth: 2,
    fillOpacity: 0.18,
    pointRadius: 4.5,
  }
}

export interface VectorImport {
  features: VectorFeature[]
  skipped: number
  detected: VectorFormat
}

interface Budget {
  points: number
}

const point = (value: unknown, budget: Budget): Position | null => {
  if (!Array.isArray(value) || value.length < 2) return null
  const lon = Number(value[0])
  const lat = Number(value[1])
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null
  budget.points += 1
  if (budget.points > MAX_VECTOR_POINTS) {
    throw new Error(
      tr(
        `Слишком много координат: лимит ${MAX_VECTOR_POINTS.toLocaleString('ru-RU')}`,
        `Too many coordinates: the limit is ${MAX_VECTOR_POINTS.toLocaleString('en-US')}`,
      ),
    )
  }
  return [lon, lat]
}

const samePoint = (left: Position, right: Position): boolean =>
  left[0] === right[0] && left[1] === right[1]

const line = (value: unknown, budget: Budget): Position[] | null => {
  if (!Array.isArray(value)) return null
  const points = value
    .map((item) => point(item, budget))
    .filter((item): item is Position => item !== null)
  if (points.length < 2) return null
  return points
}

/** GeoJSON rings must be closed; KML exporters often omit the last vertex. */
const ring = (value: unknown, budget: Budget): Position[] | null => {
  const points = line(value, budget)
  if (!points) return null
  const first = points[0]
  const last = points[points.length - 1]
  if (!samePoint(first, last)) points.push([first[0], first[1]])
  return points.length >= 4 ? points : null
}

const ringList = (
  value: unknown,
  budget: Budget,
): Position[][] | null => {
  if (!Array.isArray(value)) return null
  const rings = value
    .map((item) => ring(item, budget))
    .filter((item): item is Position[] => item !== null)
  return rings.length > 0 ? rings : null
}

function sanitizeGeometry(
  value: unknown,
  budget: Budget,
): Geometry | null {
  if (!value || typeof value !== 'object') return null
  const record = value as { type?: unknown; coordinates?: unknown; geometries?: unknown }
  const type = typeof record.type === 'string' ? record.type : ''
  switch (type) {
    case 'Point': {
      const coordinates = point(record.coordinates, budget)
      return coordinates ? { type: 'Point', coordinates } : null
    }
    case 'MultiPoint': {
      if (!Array.isArray(record.coordinates)) return null
      const coordinates = record.coordinates
        .map((item) => point(item, budget))
        .filter((item): item is Position => item !== null)
      return coordinates.length > 0
        ? { type: 'MultiPoint', coordinates }
        : null
    }
    case 'LineString': {
      const coordinates = line(record.coordinates, budget)
      return coordinates ? { type: 'LineString', coordinates } : null
    }
    case 'MultiLineString': {
      if (!Array.isArray(record.coordinates)) return null
      const coordinates = record.coordinates
        .map((item) => line(item, budget))
        .filter((item): item is Position[] => item !== null)
      return coordinates.length > 0
        ? { type: 'MultiLineString', coordinates }
        : null
    }
    case 'Polygon': {
      const coordinates = ringList(record.coordinates, budget)
      return coordinates ? { type: 'Polygon', coordinates } : null
    }
    case 'MultiPolygon': {
      if (!Array.isArray(record.coordinates)) return null
      const coordinates = record.coordinates
        .map((item) => ringList(item, budget))
        .filter((item): item is Position[][] => item !== null)
      return coordinates.length > 0
        ? { type: 'MultiPolygon', coordinates }
        : null
    }
    case 'GeometryCollection': {
      if (!Array.isArray(record.geometries)) return null
      const geometries = record.geometries
        .map((item) => sanitizeGeometry(item, budget))
        .filter((item): item is Geometry => item !== null)
      return geometries.length > 0
        ? { type: 'GeometryCollection', geometries }
        : null
    }
    default:
      return null
  }
}

const cleanText = (value: string, limit: number): string =>
  value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)

function sanitizeProperties(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const properties: Record<string, unknown> = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (Object.keys(properties).length >= MAX_PROPERTIES) break
    const key = rawKey.trim().slice(0, 120)
    if (!key) continue
    if (typeof rawValue === 'string') {
      properties[key] = rawValue.slice(0, 2000)
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      properties[key] = rawValue
    } else if (typeof rawValue === 'boolean') {
      properties[key] = rawValue
    }
  }
  return properties
}

function feature(
  geometry: Geometry,
  properties: Record<string, unknown>,
): VectorFeature {
  return {
    type: 'Feature',
    geometry,
    properties: sanitizeProperties(properties),
  }
}

function parseGeoJson(text: string): VectorImport {
  const parsed: unknown = JSON.parse(text)
  const values: unknown[] = []
  if (Array.isArray(parsed)) {
    values.push(...parsed)
  } else if (parsed && typeof parsed === 'object') {
    const root = parsed as { type?: unknown; features?: unknown }
    if (root.type === 'FeatureCollection' && Array.isArray(root.features)) {
      values.push(...root.features)
    } else if (root.type === 'Feature' || root.type === 'GeometryCollection') {
      values.push(parsed)
    } else if (typeof root.type === 'string') {
      values.push({ type: 'Feature', geometry: parsed, properties: {} })
    } else {
      throw new Error(tr('GeoJSON не содержит объектов', 'GeoJSON has no features'))
    }
  } else {
    throw new Error(tr('GeoJSON не содержит объектов', 'GeoJSON has no features'))
  }

  const budget: Budget = { points: 0 }
  const features: VectorFeature[] = []
  let skipped = 0
  for (const value of values) {
    if (features.length >= MAX_VECTOR_FEATURES) {
      skipped += 1
      continue
    }
    if (!value || typeof value !== 'object') {
      skipped += 1
      continue
    }
    const record = value as {
      type?: unknown
      geometry?: unknown
      properties?: unknown
    }
    const geometry =
      record.type === 'Feature' || record.geometry !== undefined
        ? sanitizeGeometry(record.geometry, budget)
        : sanitizeGeometry(record, budget)
    if (!geometry) {
      skipped += 1
      continue
    }
    features.push(feature(geometry, sanitizeProperties(record.properties)))
  }
  return { features, skipped, detected: 'geojson' }
}

const kmlColor = (
  value: string,
): { color: string; alpha: number } | null => {
  const hex = value.trim()
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return null
  // KML uses aabbggrr, while CSS uses rrggbb.
  const color = `#${hex.slice(6, 8)}${hex.slice(4, 6)}${hex.slice(2, 4)}`
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(0, 2), 16) / 255 : 1
  return { color: color.toLowerCase(), alpha }
}

interface KmlStyle {
  stroke?: string
  strokeOpacity?: number
  strokeWidth?: number
  fill?: string
  fillOpacity?: number
  pointColor?: string
}

function parseKmlStyle(node: XmlNode): KmlStyle {
  const style: KmlStyle = {}
  const lineStyle = child(node, 'linestyle')
  const lineColor = lineStyle && childText(lineStyle, 'color')
  if (lineColor) {
    const parsed = kmlColor(lineColor)
    if (parsed) {
      style.stroke = parsed.color
      style.strokeOpacity = parsed.alpha
    }
  }
  if (lineStyle) {
    const width = Number(childText(lineStyle, 'width'))
    if (Number.isFinite(width) && width > 0) {
      style.strokeWidth = Math.min(20, width)
    }
  }
  const polyStyle = child(node, 'polystyle')
  const fillColor = polyStyle && childText(polyStyle, 'color')
  if (fillColor) {
    const parsed = kmlColor(fillColor)
    if (parsed) {
      style.fill = parsed.color
      style.fillOpacity = Math.max(0, Math.min(1, parsed.alpha * 0.65))
    }
  }
  if (polyStyle && childText(polyStyle, 'fill') === '0') {
    style.fillOpacity = 0
  }
  const iconStyle = child(node, 'iconstyle')
  const iconColor = iconStyle && childText(iconStyle, 'color')
  if (iconColor) {
    const parsed = kmlColor(iconColor)
    if (parsed) style.pointColor = parsed.color
  }
  return style
}

function collectKmlStyles(root: XmlNode): {
  styles: Map<string, KmlStyle>
  maps: Map<string, string>
} {
  const styles = new Map<string, KmlStyle>()
  for (const node of findDescendants(root, 'style')) {
    const id = node.attrs.id
    if (id) styles.set(id, parseKmlStyle(node))
  }
  const maps = new Map<string, string>()
  for (const node of findDescendants(root, 'stylemap')) {
    const id = node.attrs.id
    if (!id) continue
    for (const pair of findDescendants(node, 'pair')) {
      const key = childText(pair, 'key').toLowerCase()
      const target = childText(pair, 'styleurl').replace(/^#/, '')
      if (key === 'normal' && target) maps.set(id, target)
    }
  }
  return { styles, maps }
}

function resolveKmlStyle(
  placemark: XmlNode,
  styles: Map<string, KmlStyle>,
  maps: Map<string, string>,
): KmlStyle {
  const inline = child(placemark, 'style')
  if (inline) return parseKmlStyle(inline)
  const reference = childText(placemark, 'styleurl').replace(/^#/, '')
  if (!reference) return {}
  const target = maps.get(reference) ?? reference
  return styles.get(target) ?? {}
}

function kmlCoordinates(node: XmlNode | undefined): string {
  if (!node) return ''
  for (const candidate of [
    childText(node, 'coordinates'),
    childText(child(node, 'lineString') ?? node, 'coordinates'),
    childText(child(node, 'linearRing') ?? node, 'coordinates'),
  ]) {
    if (candidate) return candidate
  }
  return ''
}

function parseKmlCoordinates(value: string, budget: Budget): Position[] {
  const points: Position[] = []
  for (const tuple of value.trim().split(/\s+/)) {
    if (!tuple) continue
    const [lon, lat] = tuple.split(',')
    const parsed = point([lon, lat], budget)
    if (parsed) points.push(parsed)
  }
  return points
}

function kmlLine(
  node: XmlNode,
  budget: Budget,
): LineString | null {
  const coordinates = parseKmlCoordinates(kmlCoordinates(node), budget)
  if (coordinates.length < 2) return null
  return { type: 'LineString', coordinates }
}

function kmlRing(
  node: XmlNode,
  budget: Budget,
): Position[] | null {
  const coordinates = parseKmlCoordinates(kmlCoordinates(node), budget)
  const first = coordinates[0]
  const last = coordinates[coordinates.length - 1]
  if (!first) return null
  if (!last || !samePoint(first, last)) coordinates.push([first[0], first[1]])
  return coordinates.length >= 4 ? coordinates : null
}

function kmlPolygon(
  node: XmlNode,
  budget: Budget,
): Polygon | null {
  const rings: Position[][] = []
  const outer = child(node, 'outerboundaryis')
  if (outer) {
    const ring = kmlRing(child(outer, 'linearring') ?? outer, budget)
    if (ring) rings.push(ring)
  } else {
    const ring = kmlRing(node, budget)
    if (ring) rings.push(ring)
  }
  for (const inner of node.children.filter(
    (item) => item.name === 'innerboundaryis',
  )) {
    const ring = kmlRing(child(inner, 'linearring') ?? inner, budget)
    if (ring) rings.push(ring)
  }
  return rings.length > 0 ? { type: 'Polygon', coordinates: rings } : null
}

function kmlTrack(node: XmlNode, budget: Budget): LineString | null {
  const coordinates: Position[] = []
  for (const coord of node.children.filter((item) => item.name === 'coord')) {
    const parsed = point(coord.text.trim().split(/\s+/), budget)
    if (parsed) coordinates.push(parsed)
  }
  return coordinates.length >= 2
    ? { type: 'LineString', coordinates }
    : null
}

function collectKmlGeometries(
  node: XmlNode,
  budget: Budget,
  found: Geometry[],
): void {
  for (const item of node.children) {
    switch (item.name) {
      case 'point': {
        const coordinates = parseKmlCoordinates(
          kmlCoordinates(item),
          budget,
        )[0]
        if (coordinates) found.push({ type: 'Point', coordinates })
        break
      }
      case 'linestring': {
        const geometry = kmlLine(item, budget)
        if (geometry) found.push(geometry)
        break
      }
      case 'linearring': {
        const ring = kmlRing(item, budget)
        if (ring) found.push({ type: 'LineString', coordinates: ring })
        break
      }
      case 'polygon': {
        const geometry = kmlPolygon(item, budget)
        if (geometry) found.push(geometry)
        break
      }
      case 'multigeometry':
        collectKmlGeometries(item, budget, found)
        break
      case 'track': {
        const geometry = kmlTrack(item, budget)
        if (geometry) found.push(geometry)
        break
      }
      default:
        break
    }
  }
}

function parseKml(text: string): VectorImport {
  const root = parseXml(text)
  const { styles, maps } = collectKmlStyles(root)
  const budget: Budget = { points: 0 }
  const features: VectorFeature[] = []
  let skipped = 0
  for (const placemark of findDescendants(root, 'placemark')) {
    const name = cleanText(childText(placemark, 'name'), 500)
    const description = cleanText(childText(placemark, 'description'), 5000)
    const style = resolveKmlStyle(placemark, styles, maps)
    const properties: Record<string, unknown> = {
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    }
    for (const data of findDescendants(placemark, 'data')) {
      const key = data.attrs.name
      const value = childText(data, 'value')
      if (key && value) properties[key] = value
    }
    for (const data of findDescendants(placemark, 'simpledata')) {
      const key = data.attrs.name
      const value = nodeText(data)
      if (key && value) properties[key] = value
    }
    for (const [key, value] of Object.entries(style)) {
      if (key === 'stroke' && value) properties.stroke = value
      if (key === 'strokeOpacity' && value !== undefined) {
        properties['stroke-opacity'] = value
      }
      if (key === 'strokeWidth' && value) properties['stroke-width'] = value
      if (key === 'fill' && value) properties.fill = value
      if (key === 'fillOpacity' && value !== undefined) {
        properties['fill-opacity'] = value
      }
      if (key === 'pointColor' && value) properties['marker-color'] = value
    }
    const geometries: Geometry[] = []
    collectKmlGeometries(placemark, budget, geometries)
    if (geometries.length === 0) {
      skipped += 1
      continue
    }
    for (const geometry of geometries) {
      if (features.length >= MAX_VECTOR_FEATURES) {
        skipped += 1
        continue
      }
      features.push(feature(geometry, { ...properties }))
    }
  }
  return { features, skipped, detected: 'kml' }
}

function gpxPoint(node: XmlNode, budget: Budget): Position | null {
  return point([node.attrs.lon, node.attrs.lat], budget)
}

function gpxProperties(node: XmlNode): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const key of ['name', 'desc', 'cmt', 'sym', 'type', 'time']) {
    const value = childText(node, key)
    if (value) properties[key] = cleanText(value, 2000)
  }
  const ele = Number(childText(node, 'ele'))
  if (Number.isFinite(ele)) properties.ele = ele
  return properties
}

function parseGpx(text: string): VectorImport {
  const root = parseXml(text)
  const budget: Budget = { points: 0 }
  const features: VectorFeature[] = []
  let skipped = 0
  const push = (geometry: Geometry | null, properties: Record<string, unknown>) => {
    if (!geometry || features.length >= MAX_VECTOR_FEATURES) {
      skipped += 1
      return
    }
    features.push(feature(geometry, properties))
  }

  for (const node of findDescendants(root, 'wpt')) {
    const coordinates = gpxPoint(node, budget)
    push(
      coordinates ? { type: 'Point', coordinates } : null,
      gpxProperties(node),
    )
  }
  for (const route of findDescendants(root, 'rte')) {
    const coordinates = route.children
      .filter((item) => item.name === 'rtept')
      .map((item) => gpxPoint(item, budget))
      .filter((item): item is Position => item !== null)
    push(
      coordinates.length >= 2
        ? { type: 'LineString', coordinates }
        : null,
      gpxProperties(route),
    )
  }
  for (const track of findDescendants(root, 'trk')) {
    const base = gpxProperties(track)
    const segments = track.children.filter((item) => item.name === 'trkseg')
    segments.forEach((segment, index) => {
      const coordinates = segment.children
        .filter((item) => item.name === 'trkpt')
        .map((item) => gpxPoint(item, budget))
        .filter((item): item is Position => item !== null)
      const suffix =
        segments.length > 1
          ? tr(` · сегмент ${index + 1}`, ` · segment ${index + 1}`)
          : ''
      push(
        coordinates.length >= 2
          ? { type: 'LineString', coordinates }
          : null,
        {
          ...base,
          ...(base.name ? { name: `${String(base.name)}${suffix}` } : {}),
        },
      )
    })
  }
  return { features, skipped, detected: 'gpx' }
}

function detectFormat(text: string): VectorFormat {
  const head = text.trimStart()
  if (head.startsWith('{') || head.startsWith('[')) return 'geojson'
  if (/<gpx\b/i.test(head)) return 'gpx'
  if (/<kml\b|<Placemark\b/i.test(head)) return 'kml'
  throw new Error(tr('Не удалось распознать GeoJSON, GPX или KML', 'Could not recognise GeoJSON, GPX or KML'))
}

/** Parses a UTF-8 vector document. */
export function parseVectorText(
  text: string,
  format?: VectorFormat,
): VectorImport {
  const trimmed = text.replace(/^\uFEFF/, '').trimStart()
  if (!trimmed) return { features: [], skipped: 0, detected: format ?? 'geojson' }
  const detected = format === 'kmz' ? 'kml' : (format ?? detectFormat(trimmed))
  switch (detected) {
    case 'geojson':
      return parseGeoJson(trimmed)
    case 'gpx':
      return parseGpx(trimmed)
    case 'kml':
      return parseKml(trimmed)
    default:
      throw new Error(tr('Формат KMZ требует бинарного чтения', 'The KMZ format requires binary input'))
  }
}

/**
 * Validates a layer serialized into a `.mappa` project or restored from disk.
 * Geometry and attributes go through the same bounded sanitizers as imports.
 */
export function sanitizeVectorLayer(
  value: unknown,
  index = 0,
): VectorLayer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.features)) return null
  const budget: Budget = { points: 0 }
  const features: VectorFeature[] = []
  for (const item of record.features.slice(0, MAX_VECTOR_FEATURES)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const raw = item as {
      type?: unknown
      geometry?: unknown
      properties?: unknown
    }
    const geometry =
      raw.type === 'Feature' || raw.geometry !== undefined
        ? sanitizeGeometry(raw.geometry, budget)
        : sanitizeGeometry(raw, budget)
    if (!geometry) continue
    features.push(feature(geometry, sanitizeProperties(raw.properties)))
  }
  if (features.length === 0) return null
  const style =
    record.style && typeof record.style === 'object' && !Array.isArray(record.style)
      ? (record.style as Record<string, unknown>)
      : {}
  const fallback = defaultVectorStyle(index)
  const color =
    typeof style.color === 'string' && /^#[0-9a-f]{6}$/i.test(style.color)
      ? style.color.toLowerCase()
      : fallback.color
  const lineWidth = Number(style.lineWidth)
  const fillOpacity = Number(style.fillOpacity)
  const pointRadius = Number(style.pointRadius)
  const name =
    typeof record.name === 'string' && record.name.trim()
      ? record.name.trim().replace(/\p{Cc}/gu, ' ').slice(0, 120)
      : tr(`Слой ${index + 1}`, `Layer ${index + 1}`)
  const id =
    typeof record.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(record.id)
      ? record.id
      : vectorLayerId()
  return {
    id,
    name,
    format: VECTOR_FORMATS.includes(record.format as VectorFormat)
      ? (record.format as VectorFormat)
      : 'geojson',
    features,
    style: {
      color,
      lineWidth: Number.isFinite(lineWidth)
        ? Math.max(0.5, Math.min(12, lineWidth))
        : fallback.lineWidth,
      fillOpacity: Number.isFinite(fillOpacity)
        ? Math.max(0, Math.min(1, fillOpacity))
        : fallback.fillOpacity,
      pointRadius: Number.isFinite(pointRadius)
        ? Math.max(1, Math.min(20, pointRadius))
        : fallback.pointRadius,
    },
    visible: typeof record.visible === 'boolean' ? record.visible : true,
    opacity: Number.isFinite(Number(record.opacity))
      ? Math.max(0, Math.min(1, Number(record.opacity)))
      : 1,
    source:
      typeof record.source === 'string' && record.source.length <= 4096
        ? record.source
        : null,
  }
}

/** Computes WGS84 bounds for a layer, or null when it has no coordinates. */
export function vectorBounds(features: VectorFeature[]): Bounds | null {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return
    if (
      value.length >= 2 &&
      typeof value[0] === 'number' &&
      typeof value[1] === 'number'
    ) {
      west = Math.min(west, value[0])
      east = Math.max(east, value[0])
      south = Math.min(south, value[1])
      north = Math.max(north, value[1])
      return
    }
    for (const item of value) visit(item)
  }
  for (const item of features) {
    if (item.geometry.type === 'GeometryCollection') {
      for (const geometry of item.geometry.geometries) {
        if ('coordinates' in geometry) visit(geometry.coordinates)
      }
    } else {
      visit(item.geometry.coordinates)
    }
  }
  return Number.isFinite(west) ? [[west, south], [east, north]] : null
}

export interface AttributeTable {
  columns: string[]
  rows: { id: number; values: Record<string, string> }[]
  total: number
  truncated: boolean
}

const displayValue = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(6)
  }
  return String(value)
}

/** Flattens feature properties into a table for the attribute inspector. */
export function attributeTable(
  features: VectorFeature[],
  limit = 500,
): AttributeTable {
  const seen = new Set<string>()
  for (const feature of features.slice(0, limit)) {
    for (const key of Object.keys(feature.properties ?? {})) {
      if (seen.size >= 50) break
      seen.add(key)
    }
  }
  const preferred = ['name', 'description']
  const columns = [
    ...preferred.filter((key) => seen.has(key)),
    ...[...seen].filter((key) => !preferred.includes(key)).sort(),
  ]
  const rows = features.slice(0, limit).map((feature, index) => ({
    id: index + 1,
    values: Object.fromEntries(
      columns.map((column) => [
        column,
        displayValue(feature.properties?.[column]),
      ]),
    ),
  }))
  return {
    columns,
    rows,
    total: features.length,
    truncated: features.length > limit,
  }
}
