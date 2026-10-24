import assert from 'node:assert/strict'
import test from 'node:test'

import { PROVIDERS, providerById } from '../src/providers.ts'

test('provider catalog has unique ids and valid XYZ templates', () => {
  const ids = new Set(PROVIDERS.map((provider) => provider.id))
  assert.equal(ids.size, PROVIDERS.length)
  for (const provider of PROVIDERS) {
    assert.ok(provider.label.trim())
    assert.ok(provider.attribution.trim())
    assert.ok(provider.tiles.length > 0)
    for (const template of provider.tiles) {
      assert.match(template, /\{z\}/)
      assert.match(template, /\{x\}/)
      assert.match(template, /\{y\}/)
    }
    assert.ok(provider.maxZoom >= 0)
  }
})

test('satellite providers carry their legal flags', () => {
  const esri = providerById('esri')
  assert.equal(esri.maxZoom, 19)
  assert.equal(esri.offlineAllowed, false)
  const nasa = providerById('nasa')
  assert.equal(nasa.maxZoom, 8)
  assert.equal(nasa.offlineAllowed, true)
})
