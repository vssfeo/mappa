import assert from 'node:assert/strict'
import test from 'node:test'
import { PROVIDER_PRESETS } from '../src/providerPresets.ts'

test('presets are XYZ templates and never allow offline downloads', () => {
  for (const preset of PROVIDER_PRESETS) {
    assert.match(preset.draft.url, /\{x\}.*\{y\}.*\{z\}/)
    assert.equal(preset.draft.offlineAllowed, false)
    assert.ok(preset.draft.attribution.length > 0)
    assert.ok(preset.draft.headers.Referer)
  }
})

test('preset keys and names are unique', () => {
  assert.equal(new Set(PROVIDER_PRESETS.map((item) => item.key)).size, PROVIDER_PRESETS.length)
  assert.equal(new Set(PROVIDER_PRESETS.map((item) => item.name)).size, PROVIDER_PRESETS.length)
})
