import assert from 'node:assert/strict'
import test from 'node:test'
import { entryFromIssue, validateCatalog, validatePack } from './catalog-lib.mjs'

const pack = {
  id: 'crimea-osm-12345678',
  name: 'Crimea OSM',
  bbox: [33, 44, 37, 46],
  zoom: [10, 16],
  provider: 'osm',
  bytes: 100,
  infoHash: 'a'.repeat(40),
  magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
  license: 'ODbL',
  publisher: 'vssfeo',
  publishedAt: '2026-11-06T00:00:00Z',
}

test('accepts a valid entry and rejects a mismatched magnet', () => {
  validatePack(pack)
  validateCatalog({ format: 'mappa-catalog', version: 1, updatedAt: pack.publishedAt, packs: [pack] })
  assert.throws(() => validatePack({ ...pack, magnet: `magnet:?xt=urn:btih:${'b'.repeat(40)}` }))
  assert.throws(() => validatePack({ ...pack, infoHash: '0'.repeat(40) }))
})

test('extracts JSON from a fenced issue body', () => {
  const body = `## Pack\n\n\`\`\`json\n${JSON.stringify(pack, null, 2)}\n\`\`\``
  assert.equal(entryFromIssue(body).id, pack.id)
  assert.throws(() => entryFromIssue('no json'))
})
