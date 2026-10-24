/** KML writer for imported vector layers (packed into KMZ on export). */

import type { Geometry, Position } from 'geojson'
import type { VectorLayer } from './vectorLayers.ts'
import { tr } from './locale.ts'

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

/** KML colours are `aabbggrr`. */
function kmlColor(hex: string, alpha = 1): string {
  const safe = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#ff7a45'
  const red = safe.slice(1, 3)
  const green = safe.slice(3, 5)
  const blue = safe.slice(5, 7)
  const alphaByte = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0')
  return `${alphaByte}${blue}${green}${red}`.toLowerCase()
}

const positionText = (position: Position): string =>
  `${position[0].toFixed(8)},${position[1].toFixed(8)},0`

const lineText = (positions: Position[]): string =>
  positions.map(positionText).join(' ')

const geometryXml = (geometry: Geometry): string => {
  switch (geometry.type) {
    case 'Point':
      return `<Point><coordinates>${positionText(geometry.coordinates)}</coordinates></Point>`
    case 'MultiPoint':
      return `<MultiGeometry>${geometry.coordinates
        .map((point) => geometryXml({ type: 'Point', coordinates: point }))
        .join('')}</MultiGeometry>`
    case 'LineString':
      return `<LineString><tessellate>1</tessellate><coordinates>${lineText(geometry.coordinates)}</coordinates></LineString>`
    case 'MultiLineString':
      return `<MultiGeometry>${geometry.coordinates
        .map((line) => geometryXml({ type: 'LineString', coordinates: line }))
        .join('')}</MultiGeometry>`
    case 'Polygon':
      return polygonXml(geometry.coordinates)
    case 'MultiPolygon':
      return `<MultiGeometry>${geometry.coordinates
        .map((polygon) => polygonXml(polygon))
        .join('')}</MultiGeometry>`
    case 'GeometryCollection':
      return `<MultiGeometry>${geometry.geometries
        .map(geometryXml)
        .join('')}</MultiGeometry>`
  }
}

function polygonXml(rings: Position[][]): string {
  const [outer, ...holes] = rings
  if (!outer) return ''
  const boundary = (ring: Position[], name: string) =>
    `<${name}><LinearRing><coordinates>${lineText(ring)}</coordinates></LinearRing></${name}>`
  return [
    '<Polygon>',
    boundary(outer, 'outerBoundaryIs'),
    ...holes.map((ring) => boundary(ring, 'innerBoundaryIs')),
    '</Polygon>',
  ].join('')
}

const propertiesXml = (properties: Record<string, unknown>): string => {
  const entries = Object.entries(properties).slice(0, 64)
  if (entries.length === 0) return ''
  return `<ExtendedData>${entries
    .map(
      ([key, value]) =>
        `<Data name="${escapeXml(key.slice(0, 120))}"><value>${escapeXml(
          String(value ?? '').slice(0, 2000),
        )}</value></Data>`,
    )
    .join('')}</ExtendedData>`
}

/** Serializes one imported layer as a KML 2.2 document. */
export function vectorLayerToKml(layer: VectorLayer): string {
  const placemarks = layer.features
    .map((feature, index) => {
      const properties = feature.properties ?? {}
      const name =
        typeof properties.name === 'string' && properties.name.trim()
          ? properties.name.trim()
          : tr(`Объект ${index + 1}`, `Feature ${index + 1}`)
      const description =
        typeof properties.description === 'string'
          ? `<description>${escapeXml(properties.description.slice(0, 2000))}</description>`
          : ''
      return [
        '<Placemark>',
        `<name>${escapeXml(name.slice(0, 240))}</name>`,
        description,
        '<styleUrl>#layer</styleUrl>',
        propertiesXml(properties),
        geometryXml(feature.geometry),
        '</Placemark>',
      ].join('')
    })
    .join('')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '<Document>',
    `<name>${escapeXml(layer.name.slice(0, 240))}</name>`,
    '<Style id="layer">',
    `<LineStyle><color>${kmlColor(layer.style.color, layer.opacity)}</color><width>${layer.style.lineWidth}</width></LineStyle>`,
    `<PolyStyle><color>${kmlColor(layer.style.color, layer.opacity * layer.style.fillOpacity)}</color></PolyStyle>`,
    `<IconStyle><color>${kmlColor(layer.style.color, layer.opacity)}</color><scale>1</scale></IconStyle>`,
    '</Style>',
    placemarks,
    '</Document>',
    '</kml>',
    '',
  ].join('\n')
}
