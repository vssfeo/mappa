/**
 * Minimal WKT reader for shapefile `.prj` sidecars.
 *
 * Rather than implementing projections in TypeScript, the WKT is translated
 * into either an EPSG code or a proj4 string and handed to the native proj4
 * engine. This covers СК-42/МСК Gauss-Krüger, Lambert, Albers, Mercator and
 * custom transverse Mercator grids without a GDAL dependency.
 */

import type { CrsSpec } from './native.ts'
import { tr } from './locale.ts'

type WktArg = string | number | WktNode

export interface WktNode {
  name: string
  args: WktArg[]
}

export interface PrjProjection {
  spec: CrsSpec
  label: string
}

const MAX_WKT = 16_384

const tokenize = (text: string): string[] => {
  const tokens: string[] = []
  let index = 0
  while (index < text.length) {
    const character = text[index]
    if (/\s/.test(character)) {
      index += 1
    } else if (character === '"') {
      const end = text.indexOf('"', index + 1)
      if (end < 0) throw new Error(tr('Незакрытая строка в .prj', 'Unclosed string in .prj'))
      tokens.push(text.slice(index + 1, end))
      index = end + 1
    } else if ('[](),'.includes(character)) {
      tokens.push(character)
      index += 1
    } else {
      const start = index
      while (
        index < text.length &&
        !/[\s[\]",()]/.test(text[index])
      ) {
        index += 1
      }
      tokens.push(text.slice(start, index))
    }
    if (tokens.length > 20_000) throw new Error(tr('Слишком сложный .prj', 'The .prj is too complex'))
  }
  return tokens
}

function parseNode(tokens: string[], cursor: { index: number }): WktNode {
  const name = tokens[cursor.index]
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(tr('Некорректный WKT в .prj', 'Invalid WKT in .prj'))
  }
  cursor.index += 1
  if (tokens[cursor.index] !== '[') {
    return { name, args: [] }
  }
  cursor.index += 1
  const args: WktArg[] = []
  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index]
    if (token === ']') {
      cursor.index += 1
      break
    }
    if (token === ',') {
      cursor.index += 1
      continue
    }
    if (token === '[') {
      // Defensive: malformed input must not recurse forever.
      throw new Error(tr('Некорректный WKT в .prj', 'Invalid WKT in .prj'))
    }
    if (/^[A-Za-z_]/.test(token) && tokens[cursor.index + 1] === '[') {
      args.push(parseNode(tokens, cursor))
    } else if (Number.isFinite(Number(token)) && token.trim() !== '') {
      args.push(Number(token))
      cursor.index += 1
    } else {
      args.push(token)
      cursor.index += 1
    }
  }
  return { name, args }
}

export function parseWkt(text: string): WktNode {
  const clean = text.replace(/^\uFEFF/, '').trim()
  if (!clean || clean.length > MAX_WKT) {
    throw new Error(tr('Файл проекции пуст или слишком большой', 'The projection file is empty or too large'))
  }
  const cursor = { index: 0 }
  const root = parseNode(tokenize(clean), cursor)
  return root
}

const nodes = (node: WktNode): WktNode[] =>
  node.args.filter((arg): arg is WktNode => typeof arg === 'object')

const findNodes = (node: WktNode, name: string): WktNode[] => {
  const wanted = name.toUpperCase()
  const result: WktNode[] = []
  const visit = (current: WktNode, depth: number) => {
    if (depth > 12) return
    for (const child of nodes(current)) {
      if (child.name.toUpperCase() === wanted) result.push(child)
      visit(child, depth + 1)
    }
  }
  visit(node, 0)
  return result
}

const direct = (node: WktNode, name: string): WktNode[] =>
  nodes(node).filter((child) => child.name.toUpperCase() === name.toUpperCase())

const textArgs = (node: WktNode): string[] =>
  node.args.filter((arg): arg is string => typeof arg === 'string')

const numberArgs = (node: WktNode): number[] =>
  node.args.filter((arg): arg is number => typeof arg === 'number')

/** EPSG code from `AUTHORITY` (WKT1) or `ID` (WKT2) on the root object. */
function rootEpsg(root: WktNode): number | null {
  for (const name of ['AUTHORITY', 'ID']) {
    for (const node of direct(root, name)) {
      const args = textArgs(node)
      const code = Number(args[1] ?? numberArgs(node)[0])
      if (args[0]?.toUpperCase() === 'EPSG' && Number.isInteger(code)) {
        return code
      }
    }
  }
  return null
}

const normalize = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '')

const datumToken = (name: string): string | null => {
  const key = normalize(name)
  if (key.includes('wgs1984') || key === 'wgs84') return '+datum=WGS84'
  if (
    key.includes('pulkovo') ||
    key.includes('krassovsky') ||
    key.includes('krasovsky') ||
    key.includes('sk42') ||
    key.includes('SK_42'.toLowerCase())
  ) {
    return '+ellps=krass'
  }
  if (key.includes('grs1980')) return '+ellps=GRS80'
  if (key.includes('bessel')) return '+ellps=bessel'
  if (key.includes('clarke1866')) return '+ellps=clrk66'
  if (key.includes('international1924')) return '+ellps=intl'
  if (key.includes('airy')) return '+ellps=airy'
  return null
}

function ellipsoidToken(root: WktNode): string | null {
  const datum = findNodes(root, 'DATUM')[0] ?? findNodes(root, 'GEODETICDATUM')[0]
  if (datum) {
    const known = datumToken(textArgs(datum)[0] ?? '')
    if (known) return known
  }
  const ellipsoid =
    findNodes(root, 'ELLIPSOID')[0] ?? findNodes(root, 'SPHEROID')[0]
  if (!ellipsoid) return null
  const values = numberArgs(ellipsoid)
  const semiMajor = values[0]
  const inverseFlattening = values[1]
  if (!Number.isFinite(semiMajor) || semiMajor <= 0) return null
  if (Number.isFinite(inverseFlattening) && inverseFlattening > 0) {
    return `+a=${semiMajor} +rf=${inverseFlattening}`
  }
  return `+a=${semiMajor} +b=${semiMajor}`
}

const PARAMETER_NAMES: Record<string, string> = {
  latitudeoforigin: 'lat_0',
  latitudeofnaturalorigin: 'lat_0',
  latitudeofcenter: 'lat_0',
  latitudeoffalseorigin: 'lat_0',
  latitudeof1ststandardparallel: 'lat_1',
  latitudeof2ndstandardparallel: 'lat_2',
  standardparallel1: 'lat_1',
  standardparallel2: 'lat_2',
  centralmeridian: 'lon_0',
  longitudeofnaturalorigin: 'lon_0',
  longitudeofcenter: 'lon_0',
  longitudeoffalseorigin: 'lon_0',
  longitudeoforigin: 'lon_0',
  scalefactor: 'k',
  scalefactoratnaturalorigin: 'k',
  falseeasting: 'x_0',
  falsenorthing: 'y_0',
  eastingatfalseorigin: 'x_0',
  northingatfalseorigin: 'y_0',
}

function projectionParameters(root: WktNode): Record<string, number> {
  const values: Record<string, number> = {}
  for (const parameter of findNodes(root, 'PARAMETER')) {
    const name = PARAMETER_NAMES[normalize(textArgs(parameter)[0] ?? '')]
    const value = numberArgs(parameter)[0]
    if (!name || !Number.isFinite(value)) continue
    values[name] = value
  }
  return values
}

function linearUnit(root: WktNode): number {
  let linear = 1
  for (const name of ['UNIT', 'LENGTHUNIT']) {
    for (const unit of findNodes(root, name)) {
      const factor = numberArgs(unit)[0]
      // WKT1 nests the geographic degree unit inside PROJCS; the projected
      // unit is the largest factor (1 for metre, 0.3048 for feet, 0.01745
      // for degrees). Taking the maximum avoids reading degrees as metres.
      if (Number.isFinite(factor) && factor > linear) linear = factor
    }
  }
  return linear
}

function projString(root: WktNode): string | null {
  const methodNode =
    findNodes(root, 'PROJECTION')[0] ?? findNodes(root, 'METHOD').at(-1)
  const method = normalize(textArgs(methodNode ?? root)[0] ?? '')
  const ellipsoid = ellipsoidToken(root)
  if (!ellipsoid) return null
  const parameters = projectionParameters(root)
  const unit = linearUnit(root)
  const number = (value: number | undefined, fallback: number) =>
    Number.isFinite(value) ? Number(value) : fallback
  const x = number(parameters.x_0, 0) * unit
  const y = number(parameters.y_0, 0) * unit
  const extra = [`+x_0=${x}`, `+y_0=${y}`, '+units=m', '+no_defs'].join(' ')

  if (
    method.includes('transversemercator') ||
    method.includes('gausskruger') ||
    method.includes('gauss') ||
    method.includes('tmerc')
  ) {
    return `+proj=tmerc +lat_0=${number(parameters.lat_0, 0)} +lon_0=${number(parameters.lon_0, 0)} +k=${number(parameters.k, 1)} ${ellipsoid} ${extra}`
  }
  if (method.includes('lambertconformalconic') || method.includes('lcc')) {
    const lat1 = number(parameters.lat_1, parameters.lat_0 ?? 0)
    return `+proj=lcc +lat_1=${lat1} +lat_2=${number(parameters.lat_2, lat1)} +lat_0=${number(parameters.lat_0, 0)} +lon_0=${number(parameters.lon_0, 0)} ${ellipsoid} ${extra}`
  }
  if (method.includes('albers') || method.includes('aea')) {
    return `+proj=aea +lat_1=${number(parameters.lat_1, 0)} +lat_2=${number(parameters.lat_2, 0)} +lat_0=${number(parameters.lat_0, 0)} +lon_0=${number(parameters.lon_0, 0)} ${ellipsoid} ${extra}`
  }
  if (method.includes('mercator') || method.includes('merc')) {
    return `+proj=merc +lat_ts=${number(parameters.lat_1, 0)} +lon_0=${number(parameters.lon_0, 0)} +k=${number(parameters.k, 1)} ${ellipsoid} ${extra}`
  }
  if (method.includes('stereographic') || method.includes('stere')) {
    return `+proj=stere +lat_0=${number(parameters.lat_0, 0)} +lon_0=${number(parameters.lon_0, 0)} +k=${number(parameters.k, 1)} ${ellipsoid} ${extra}`
  }
  return null
}

/** Resolves a `.prj` WKT into an EPSG code or a proj4 string. */
export function projectionFromWkt(text: string): PrjProjection | null {
  let root: WktNode
  try {
    root = parseWkt(text)
  } catch {
    return null
  }
  const label =
    textArgs(root)[0]?.trim().slice(0, 120) || tr('Проекция из .prj', 'Projection from .prj')
  const epsg = rootEpsg(root)
  if (epsg && epsg > 0 && epsg <= 65_535) {
    return { spec: { epsg }, label: `${label} (EPSG:${epsg})` }
  }
  const proj = projString(root)
  if (proj) {
    return { spec: { proj }, label }
  }
  return null
}
