#!/usr/bin/env node
// Validates catalog/catalog.json without external dependencies.
import { readFileSync } from 'node:fs'

const path = new URL('../catalog/catalog.json', import.meta.url)
const data = JSON.parse(readFileSync(path, 'utf8'))
const fail = (message) => {
  console.error(`catalog: ${message}`)
  process.exit(1)
}

if (data.format !== 'mappa-catalog' || data.version !== 1) fail('format/version')
if (!Array.isArray(data.packs)) fail('packs must be an array')
if (Number.isNaN(Date.parse(data.updatedAt))) fail('updatedAt must be a date')

const ids = new Set()
for (const [index, pack] of data.packs.entries()) {
  const where = `packs[${index}]`
  for (const key of ['id', 'name', 'provider', 'license', 'publisher', 'publishedAt']) {
    if (typeof pack[key] !== 'string' || pack[key].length === 0) fail(`${where}.${key}`)
  }
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(pack.id)) fail(`${where}.id`)
  if (ids.has(pack.id)) fail(`${where}.id is duplicated`)
  ids.add(pack.id)
  if (!Array.isArray(pack.bbox) || pack.bbox.length !== 4) fail(`${where}.bbox`)
  const [west, south, east, north] = pack.bbox
  if (![west, south, east, north].every((value) => typeof value === 'number')) fail(`${where}.bbox numbers`)
  if (west >= east || south >= north || south < -85 || north > 85) fail(`${where}.bbox range`)
  if (!Array.isArray(pack.zoom) || pack.zoom.length !== 2) fail(`${where}.zoom`)
  if (!Number.isInteger(pack.zoom[0]) || !Number.isInteger(pack.zoom[1]) || pack.zoom[0] > pack.zoom[1]) fail(`${where}.zoom range`)
  if (!Number.isInteger(pack.bytes) || pack.bytes <= 0) fail(`${where}.bytes`)
  if (!/^[0-9a-f]{40}$/.test(pack.infoHash)) fail(`${where}.infoHash`)
  if (typeof pack.magnet !== 'string' || !pack.magnet.startsWith('magnet:?xt=urn:btih:')) fail(`${where}.magnet`)
  if (Number.isNaN(Date.parse(pack.publishedAt))) fail(`${where}.publishedAt`)
}
console.log(`catalog: ${data.packs.length} packs OK`)
