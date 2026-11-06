// Shared validation for the static pack catalog.
const ID = /^[a-z0-9][a-z0-9-]{1,63}$/
const HASH = /^[0-9a-f]{40}$/

export class CatalogError extends Error {}

const fail = (message) => {
  throw new CatalogError(message)
}

export function validatePack(pack, where = 'entry') {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) fail(`${where} must be an object`)
  for (const key of ['id', 'name', 'provider', 'license', 'publisher', 'publishedAt']) {
    if (typeof pack[key] !== 'string' || pack[key].trim().length === 0) fail(`${where}.${key}`)
  }
  if (pack.name.length > 200) fail(`${where}.name is too long`)
  if (pack.license.length > 200) fail(`${where}.license is too long`)
  if (pack.publisher.length > 100) fail(`${where}.publisher is too long`)
  if (!ID.test(pack.id)) fail(`${where}.id`)
  if (!Array.isArray(pack.bbox) || pack.bbox.length !== 4) fail(`${where}.bbox`)
  const [west, south, east, north] = pack.bbox
  if (![west, south, east, north].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    fail(`${where}.bbox numbers`)
  }
  if (west >= east || south >= north || south < -85 || north > 85) fail(`${where}.bbox range`)
  if (!Array.isArray(pack.zoom) || pack.zoom.length !== 2) fail(`${where}.zoom`)
  if (!Number.isInteger(pack.zoom[0]) || !Number.isInteger(pack.zoom[1]) || pack.zoom[0] > pack.zoom[1]) {
    fail(`${where}.zoom range`)
  }
  if (pack.zoom[0] < 0 || pack.zoom[1] > 22) fail(`${where}.zoom limits`)
  if (!Number.isInteger(pack.bytes) || pack.bytes <= 0) fail(`${where}.bytes`)
  if (!HASH.test(pack.infoHash)) fail(`${where}.infoHash`)
  if (/^0{40}$/.test(pack.infoHash)) fail(`${where}.infoHash is a placeholder`)
  if (typeof pack.magnet !== 'string' || pack.magnet.length > 4096) fail(`${where}.magnet`)
  if (!pack.magnet.startsWith('magnet:?xt=urn:btih:')) fail(`${where}.magnet prefix`)
  const magnetHash = pack.magnet.slice('magnet:?xt=urn:btih:'.length, 'magnet:?xt=urn:btih:'.length + 40)
  if (magnetHash.toLowerCase() !== pack.infoHash) fail(`${where}.magnet does not match infoHash`)
  if (Number.isNaN(Date.parse(pack.publishedAt))) fail(`${where}.publishedAt`)
}

export function validateCatalog(data) {
  if (data.format !== 'mappa-catalog' || data.version !== 1) fail('format/version')
  if (!Array.isArray(data.packs)) fail('packs must be an array')
  if (Number.isNaN(Date.parse(data.updatedAt))) fail('updatedAt must be a date')
  const ids = new Set()
  for (const [index, pack] of data.packs.entries()) {
    validatePack(pack, `packs[${index}]`)
    if (ids.has(pack.id)) fail(`packs[${index}].id is duplicated`)
    ids.add(pack.id)
  }
}

export function entryFromIssue(body) {
  if (typeof body !== 'string') fail('issue body is empty')
  if (body.length > 64 * 1024) fail('issue body is too large')
  const match = body.match(/```json\s*([\s\S]*?)```/i)
  const text = match ? match[1] : body
  let entry
  try {
    entry = JSON.parse(text)
  } catch {
    fail('no JSON object in the issue body')
  }
  validatePack(entry)
  return entry
}
