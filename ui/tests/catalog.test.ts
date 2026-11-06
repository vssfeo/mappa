import assert from 'node:assert/strict'
import test from 'node:test'
import { catalogEntry, catalogIssueUrl, filterPacks, type CatalogPack } from '../src/catalog.ts'

const base: CatalogPack = {
  id: 'crimea-osm',
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

test('filters by viewport, zoom, provider and text', () => {
  const packs = [base, { ...base, id: 'far', name: 'Far', bbox: [0, 0, 1, 1] }]
  assert.equal(
    filterPacks(packs, {
      bounds: [[34, 45], [35, 45.5]],
      zoom: 14,
      provider: 'osm',
      onlyVisible: true,
    }).length,
    1,
  )
  assert.equal(filterPacks(packs, { bounds: null, zoom: 20 }).length, 0)
  assert.equal(filterPacks(packs, { bounds: null, zoom: 14, query: 'far' }).length, 1)
})

test('catalog entry keeps the torrent hash and bbox', () => {
  const entry = catalogEntry({
    pack: {
      name: 'Crimea OSM',
      west: 33,
      south: 44,
      east: 37,
      north: 46,
      minZoom: 10,
      maxZoom: 16,
      bytes: 100,
    },
    provider: 'osm',
    infoHash: 'b'.repeat(40),
    magnet: `magnet:?xt=urn:btih:${'b'.repeat(40)}`,
    license: 'ODbL',
    publisher: 'vssfeo',
  })
  assert.deepEqual(entry.bbox, [33, 44, 37, 46])
  assert.deepEqual(entry.zoom, [10, 16])
  assert.equal(entry.infoHash, 'b'.repeat(40))
  assert.match(entry.id, /^crimea-osm-bbbbbbbb$/)
})


test('builds an issue URL with the encoded entry', () => {
  const url = catalogIssueUrl(base)
  assert.ok(url.startsWith('https://github.com/vssfeo/mappa/issues/new?'))
  assert.ok(url.includes('title=catalog%3A%20Crimea%20OSM'))
  assert.ok(url.includes('body='))
})
