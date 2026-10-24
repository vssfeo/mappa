/** Marker model plus bulk import/export in WGS84, DMS and UTM. */

import {
  formatDms,
  lonLatToUtm,
  parseAngle,
  utmToLonLat,
  type LonLat,
} from './geo.ts'
import { tr } from './locale.ts'
import { lonLatToMgrs } from './mgrs.ts'

export type CoordinateFormat = 'dd' | 'dms' | 'utm' | 'mgrs'
export type MarkerFileFormat = 'geojson' | 'csv' | 'gpx' | 'kml' | 'kmz'

export interface MapMarker {
  id: string
  name: string
  lon: number
  lat: number
  /** Optional elevation in metres; reserved for terrain-aware tools. */
  elevation?: number
  description?: string
  /** Optional user folder; markers are grouped by it in the panel. */
  folder?: string
  /** Emoji or short glyph shown inside the map pin. */
  icon?: string
  /** Pin colour as `#rrggbb`. */
  color?: string
}

export interface MarkerImport {
  markers: MapMarker[]
  skipped: number
}

/** Guardrails for imported cells and the local marker store. */
export const MAX_MARKERS = 20_000
const MAX_NAME_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 2_000

export const markerId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `marker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const angle = (value: number) => Number(value.toFixed(6))

const headerAliases = {
  name: ['name', 'имя', 'название', 'title', 'label', 'метка', 'точка'],
  lat: ['lat', 'latitude', 'широта'],
  lon: ['lon', 'lng', 'long', 'longitude', 'долгота'],
  description: [
    'description',
    'desc',
    'comment',
    'описание',
    'комментарий',
    'примечание',
  ],
  folder: ['folder', 'папка', 'group', 'группа', 'category'],
  icon: ['icon', 'иконка', 'symbol', 'sym'],
  color: ['color', 'colour', 'цвет', 'marker-color'],
  zone: ['zone', 'utm_zone', 'зона'],
  hemisphere: ['hemisphere', 'hem', 'полушарие'],
  easting: ['easting', 'east', 'utm_easting', 'восток'],
  northing: ['northing', 'north', 'utm_northing', 'север'],
} as const

type ColumnKey = keyof typeof headerAliases

const normalizeHeader = (value: string) =>
  value.replace(/^\uFEFF/, '').trim().toLowerCase()

const findColumn = (headers: string[], key: ColumnKey): number =>
  headers.findIndex((header) => headerAliases[key].includes(header as never))

/** Splits delimiter-separated text with quote support. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const source = text.replace(/^\uFEFF/, '')

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (!quoted && character === delimiter) {
      row.push(cell)
      cell = ''
      continue
    }
    if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && source[index + 1] === '\n') index += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      continue
    }
    cell += character
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((entry) => entry.some((value) => value.trim().length > 0))
}

/** Picks `;`, `,` or tab from the header line. */
export function detectDelimiter(text: string): string {
  const line = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? ''
  const counts: [string, number][] = [
    [';', (line.match(/;/g) ?? []).length],
    [',', (line.match(/,/g) ?? []).length],
    ['\t', (line.match(/\t/g) ?? []).length],
  ]
  counts.sort((left, right) => right[1] - left[1])
  return counts[0][1] > 0 ? counts[0][0] : ';'
}

function cellAt(row: string[], index: number): string {
  return index >= 0 ? (row[index] ?? '').trim() : ''
}

function parsePlainNumber(value: string): number {
  return Number(value.replace(/\s/g, '').replace(',', '.'))
}

function parseLatitude(text: string): number {
  const value = parseAngle(text)
  return value >= -90 && value <= 90 ? value : Number.NaN
}

function parseLongitude(text: string): number {
  const value = parseAngle(text)
  return value >= -180 && value <= 180 ? value : Number.NaN
}

function normalizeHemisphere(value: string): 'N' | 'S' | null {
  const text = value.trim().toUpperCase()
  if (['N', 'NORTH', 'С', 'СЕВЕР'].includes(text)) return 'N'
  if (['S', 'SOUTH', 'Ю', 'ЮГ'].includes(text)) return 'S'
  return null
}

function parseZone(value: string, hemisphere: string): {
  zone: number
  hemisphere: 'N' | 'S'
} | null {
  const match = value.trim().match(/^(\d{1,2})\s*([NSЮС]?)$/i)
  if (!match) return null
  const zone = Number(match[1])
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) return null
  const fromCell = hemisphere ? normalizeHemisphere(hemisphere) : null
  const fromZone = match[2] ? normalizeHemisphere(match[2]) : null
  return { zone, hemisphere: fromCell ?? fromZone ?? 'N' }
}

interface MarkerExtras {
  folder?: unknown
  icon?: unknown
  color?: unknown
}

const cleanFolder = (value: unknown): string =>
  typeof value === 'string' ? value.trim().slice(0, 80) : ''

const cleanIcon = (value: unknown): string =>
  typeof value === 'string' ? Array.from(value.trim()).slice(0, 2).join('') : ''

const cleanColor = (value: unknown): string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : ''

function markerFromValues(
  name: string,
  description: string,
  lon: number,
  lat: number,
  extras: MarkerExtras = {},
): MapMarker | null {
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    return null
  }
  const cleanName = name.trim().slice(0, MAX_NAME_LENGTH)
  const cleanDescription = description
    .trim()
    .slice(0, MAX_DESCRIPTION_LENGTH)
  const folder = cleanFolder(extras.folder)
  const icon = cleanIcon(extras.icon)
  const color = cleanColor(extras.color)
  return {
    id: markerId(),
    name: cleanName || tr('Метка', 'Marker'),
    lon: angle(lon),
    lat: angle(lat),
    ...(cleanDescription ? { description: cleanDescription } : {}),
    ...(folder ? { folder } : {}),
    ...(icon ? { icon } : {}),
    ...(color ? { color } : {}),
  }
}

function parseCsv(
  text: string,
  format: CoordinateFormat,
  delimiter?: string,
): MarkerImport {
  const separator = delimiter ?? detectDelimiter(text)
  const rows = parseDelimited(text, separator)
  if (rows.length === 0) return { markers: [], skipped: 0 }

  const headers = rows[0].map(normalizeHeader)
  const columns = {
    name: findColumn(headers, 'name'),
    lat: findColumn(headers, 'lat'),
    lon: findColumn(headers, 'lon'),
    description: findColumn(headers, 'description'),
    folder: findColumn(headers, 'folder'),
    icon: findColumn(headers, 'icon'),
    color: findColumn(headers, 'color'),
    zone: findColumn(headers, 'zone'),
    hemisphere: findColumn(headers, 'hemisphere'),
    easting: findColumn(headers, 'easting'),
    northing: findColumn(headers, 'northing'),
  }
  const hasHeader =
    columns.name >= 0 ||
    columns.lat >= 0 ||
    columns.lon >= 0 ||
    columns.zone >= 0 ||
    columns.easting >= 0
  const body = hasHeader ? rows.slice(1) : rows
  const markers: MapMarker[] = []
  let skipped = 0

  body.forEach((row, index) => {
    const name = hasHeader
      ? cellAt(row, columns.name)
      : cellAt(row, 0)
    const description = hasHeader
      ? cellAt(row, columns.description)
      : cellAt(row, format === 'utm' ? 5 : 3)

    let coordinates: LonLat | null = null
    if (format === 'utm' && hasHeader && columns.zone >= 0) {
      const zoneInfo = parseZone(
        cellAt(row, columns.zone),
        cellAt(row, columns.hemisphere),
      )
      const easting = parsePlainNumber(cellAt(row, columns.easting))
      const northing = parsePlainNumber(cellAt(row, columns.northing))
      if (
        zoneInfo &&
        Number.isFinite(easting) &&
        Number.isFinite(northing) &&
        easting >= 100_000 &&
        easting <= 900_000 &&
        northing >= 0 &&
        northing <= 10_000_000
      ) {
        coordinates = utmToLonLat({ ...zoneInfo, easting, northing })
      }
    } else if (format === 'utm' && !hasHeader) {
      const zoneInfo = parseZone(cellAt(row, 1), cellAt(row, 2))
      const easting = parsePlainNumber(cellAt(row, 3))
      const northing = parsePlainNumber(cellAt(row, 4))
      if (
        zoneInfo &&
        Number.isFinite(easting) &&
        Number.isFinite(northing)
      ) {
        coordinates = utmToLonLat({ ...zoneInfo, easting, northing })
      }
    } else {
      const latText = hasHeader ? cellAt(row, columns.lat) : cellAt(row, 1)
      const lonText = hasHeader ? cellAt(row, columns.lon) : cellAt(row, 2)
      if (latText && lonText) {
        const lat = parseLatitude(latText)
        const lon = parseLongitude(lonText)
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          coordinates = [lon, lat]
        }
      }
    }

    if (!coordinates) {
      skipped += 1
      return
    }
    const marker = markerFromValues(
      name || tr(`Метка ${index + 1}`, `Marker ${index + 1}`),
      description,
      coordinates[0],
      coordinates[1],
      {
        folder: hasHeader ? cellAt(row, columns.folder) : '',
        icon: hasHeader ? cellAt(row, columns.icon) : '',
        color: hasHeader ? cellAt(row, columns.color) : '',
      },
    )
    if (marker) markers.push(marker)
    else skipped += 1
  })

  return { markers, skipped }
}

interface GeoJsonFeature {
  type?: string
  geometry?: { type?: string; coordinates?: unknown } | null
  properties?: Record<string, unknown> | null
}

function parseJsonMarker(value: unknown): MapMarker | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const name =
    (record.name as string | undefined) ??
    (record.title as string | undefined) ??
    ''
  const description =
    (record.description as string | undefined) ??
    (record.comment as string | undefined) ??
    ''
  const lon = Number(
    record.lon ?? record.lng ?? record.longitude ?? record.long,
  )
  const lat = Number(record.lat ?? record.latitude)
  return markerFromValues(name, description, lon, lat, {
    folder: record.folder ?? record.group,
    icon: record.icon ?? record.symbol,
    color: record.color ?? record['marker-color'],
  })
}

function parseFeature(feature: GeoJsonFeature): MapMarker | null {
  if (feature?.geometry?.type !== 'Point') return null
  const coordinates = feature.geometry.coordinates
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null
  const lon = Number(coordinates[0])
  const lat = Number(coordinates[1])
  const properties = feature.properties ?? {}
  const name =
    (properties.name as string | undefined) ??
    (properties.title as string | undefined) ??
    (properties.label as string | undefined) ??
    ''
  const description =
    (properties.description as string | undefined) ??
    (properties.comment as string | undefined) ??
    ''
  return markerFromValues(name, description, lon, lat, {
    folder: properties.folder ?? properties.group,
    icon: properties.icon ?? properties.symbol,
    color: properties.color ?? properties['marker-color'],
  })
}

function parseGeoJson(text: string): MarkerImport {
  const parsed: unknown = JSON.parse(text)
  const values: unknown[] = []
  if (Array.isArray(parsed)) {
    values.push(...parsed)
  } else if (parsed && typeof parsed === 'object') {
    const root = parsed as Record<string, unknown>
    if (Array.isArray(root.features)) values.push(...root.features)
    else if (Array.isArray(root.markers)) values.push(...root.markers)
    else values.push(parsed)
  } else {
    throw new Error(tr('GeoJSON не содержит объектов', 'GeoJSON has no features'))
  }

  const markers: MapMarker[] = []
  let skipped = 0
  for (const value of values) {
    const record = value as GeoJsonFeature
    const marker =
      record?.type === 'Feature' || record?.geometry
        ? parseFeature(record)
        : parseJsonMarker(value)
    if (marker) markers.push(marker)
    else skipped += 1
  }
  return { markers, skipped }
}

const xmlEscape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

const xmlUnescape = (value: string): string =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')

const xmlText = (block: string, tag: string): string => {
  const match = block.match(
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'),
  )
  if (!match) return ''
  const raw = match[1]
    .trim()
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
  return xmlUnescape(raw).trim()
}

const kmlData = (block: string, key: string): string => {
  const match = block.match(
    new RegExp(`<Data\\b[^>]*name=["']${key}["'][^>]*>([\\s\\S]*?)</Data>`, 'i'),
  )
  return match ? xmlText(match[1], 'value') : ''
}

const xmlAttribute = (tag: string, name: string): string => {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'),
  )
  return match ? match[1] : ''
}

function parseGpx(text: string): MarkerImport {
  const markers: MapMarker[] = []
  let skipped = 0
  const points =
    /<wpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/wpt>)/gi
  for (const match of text.matchAll(points)) {
    const attributes = match[1] ?? ''
    const body = match[2] ?? ''
    const lat = parseAngle(xmlAttribute(attributes, 'lat'))
    const lon = parseAngle(xmlAttribute(attributes, 'lon'))
    const marker = markerFromValues(
      xmlText(body, 'name'),
      xmlText(body, 'desc'),
      lon,
      lat,
      {
        folder: xmlText(body, 'type'),
        icon: xmlText(body, 'sym'),
      },
    )
    if (marker) markers.push(marker)
    else skipped += 1
  }
  return { markers, skipped }
}

function parseKml(text: string): MarkerImport {
  const markers: MapMarker[] = []
  let skipped = 0
  for (const match of text.matchAll(
    /<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi,
  )) {
    const block = match[1] ?? ''
    const point = block.match(/<Point\b[^>]*>([\s\S]*?)<\/Point>/i)
    const coordinates = point?.[1].match(
      /<coordinates\b[^>]*>([\s\S]*?)<\/coordinates>/i,
    )
    if (!coordinates) {
      skipped += 1
      continue
    }
    const first = coordinates[1].trim().split(/\s+/)[0] ?? ''
    const [lonText, latText] = first.split(',')
    const description = xmlText(block, 'description')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const marker = markerFromValues(
      xmlText(block, 'name'),
      description,
      Number(lonText),
      Number(latText),
      {
        folder: kmlData(block, 'folder') || xmlText(block, 'folder'),
        icon: kmlData(block, 'icon') || xmlText(block, 'icon'),
        color: kmlData(block, 'color') || xmlText(block, 'color'),
      },
    )
    if (marker) markers.push(marker)
    else skipped += 1
  }
  return { markers, skipped }
}

/** Parses GeoJSON, CSV, GPX or KML markers. Throws on unreadable input. */
export function importMarkers(
  text: string,
  format: CoordinateFormat,
  delimiter?: string,
): MarkerImport {
  const trimmed = text.replace(/^\uFEFF/, '').trimStart()
  if (!trimmed) return { markers: [], skipped: 0 }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseGeoJson(trimmed)
  }
  if (trimmed.startsWith('<')) {
    if (/<wpt\b/i.test(trimmed)) return parseGpx(trimmed)
    if (/<kml\b|<Placemark\b/i.test(trimmed)) return parseKml(trimmed)
    throw new Error(tr('Не удалось распознать GPX или KML', 'Could not parse GPX or KML'))
  }
  return parseCsv(trimmed, format, delimiter)
}

function csvCell(value: string, delimiter: string): string {
  if (
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return `"${value.replaceAll('"', '""')}"`
  }
  return value
}

function csvLine(cells: string[], delimiter: string): string {
  return cells.map((cell) => csvCell(cell, delimiter)).join(delimiter)
}

export interface CsvExportOptions {
  /** Field separator; comma, semicolon or tab. */
  delimiter?: string
  includeDescription?: boolean
  includeFolder?: boolean
  includeIcon?: boolean
  includeColor?: boolean
}

/** Serializes markers as GeoJSON/GPX/KML (WGS84) or CSV. */
export function exportMarkers(
  markers: MapMarker[],
  format: MarkerFileFormat,
  coordinateFormat: CoordinateFormat,
  options: CsvExportOptions = {},
): string {
  const {
    delimiter = ';',
    includeDescription = true,
    includeFolder = true,
    includeIcon = true,
    includeColor = true,
  } = options
  if (format === 'gpx') {
    const points = markers.map((marker) => {
      const description = marker.description
        ? `\n    <desc>${xmlEscape(marker.description)}</desc>`
        : ''
      const sym = marker.icon
        ? `\n    <sym>${xmlEscape(marker.icon)}</sym>`
        : ''
      const type = marker.folder
        ? `\n    <type>${xmlEscape(marker.folder)}</type>`
        : ''
      return `  <wpt lat="${marker.lat.toFixed(6)}" lon="${marker.lon.toFixed(6)}">
    <name>${xmlEscape(marker.name)}</name>${description}${sym}${type}
  </wpt>`
    })
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Mappa" xmlns="http://www.topografix.com/GPX/1/1">
${points.join('\n')}
</gpx>
`
  }

  if (format === 'kml' || format === 'kmz') {
    const placemarks = markers.map((marker) => {
      const description = marker.description
        ? `\n      <description>${xmlEscape(marker.description)}</description>`
        : ''
      const extras = [
        marker.folder ? ['folder', marker.folder] : null,
        marker.icon ? ['icon', marker.icon] : null,
        marker.color ? ['color', marker.color] : null,
      ]
        .filter((entry): entry is string[] => entry !== null)
        .map(
          ([key, value]) =>
            `        <Data name="${key}"><value>${xmlEscape(value)}</value></Data>`,
        )
      const extended = extras.length
        ? `\n      <ExtendedData>\n${extras.join('\n')}\n      </ExtendedData>`
        : ''
      return `    <Placemark>
      <name>${xmlEscape(marker.name)}</name>${description}${extended}
      <Point><coordinates>${marker.lon.toFixed(6)},${marker.lat.toFixed(6)},0</coordinates></Point>
    </Placemark>`
    })
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
${placemarks.join('\n')}
  </Document>
</kml>
`
  }

  if (format === 'geojson') {
    return `${JSON.stringify(
      {
        type: 'FeatureCollection',
        features: markers.map((marker) => ({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [marker.lon, marker.lat],
          },
          properties: {
            name: marker.name,
            ...(marker.description
              ? { description: marker.description }
              : {}),
            ...(marker.folder ? { folder: marker.folder } : {}),
            ...(marker.icon ? { icon: marker.icon } : {}),
            ...(marker.color ? { color: marker.color } : {}),
          },
        })),
      },
      null,
      2,
    )}\n`
  }

  let coordinateHeaders: string[]
  let coordinateValues: (marker: MapMarker) => string[]
  if (coordinateFormat === 'mgrs') {
    coordinateHeaders = ['mgrs']
    coordinateValues = (marker) => [
      lonLatToMgrs(marker.lon, marker.lat) ?? '',
    ]
  } else if (coordinateFormat === 'utm') {
    coordinateHeaders = ['zone', 'hemisphere', 'easting', 'northing']
    coordinateValues = (marker) => {
      const utm = lonLatToUtm(marker.lon, marker.lat)
      return [
        String(utm.zone),
        utm.hemisphere,
        utm.easting.toFixed(2),
        utm.northing.toFixed(2),
      ]
    }
  } else {
    const useDms = coordinateFormat === 'dms'
    coordinateHeaders = [
      useDms ? 'latitude' : 'lat',
      useDms ? 'longitude' : 'lon',
    ]
    coordinateValues = (marker) => [
      useDms ? formatDms(marker.lat, 'lat') : marker.lat.toFixed(6),
      useDms ? formatDms(marker.lon, 'lon') : marker.lon.toFixed(6),
    ]
  }

  const optionalColumns = [
    includeDescription && {
      header: 'description',
      value: (marker: MapMarker) => marker.description ?? '',
    },
    includeFolder && {
      header: 'folder',
      value: (marker: MapMarker) => marker.folder ?? '',
    },
    includeIcon && {
      header: 'icon',
      value: (marker: MapMarker) => marker.icon ?? '',
    },
    includeColor && {
      header: 'color',
      value: (marker: MapMarker) => marker.color ?? '',
    },
  ].filter((column): column is { header: string; value: (marker: MapMarker) => string } =>
    Boolean(column),
  )

  const lines = [
    csvLine(
      ['name', ...coordinateHeaders, ...optionalColumns.map((column) => column.header)],
      delimiter,
    ),
  ]
  for (const marker of markers) {
    lines.push(
      csvLine(
        [
          marker.name,
          ...coordinateValues(marker),
          ...optionalColumns.map((column) => column.value(marker)),
        ],
        delimiter,
      ),
    )
  }
  return `\uFEFF${lines.join('\n')}\n`
}
