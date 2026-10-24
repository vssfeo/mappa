import assert from 'node:assert/strict'
import test from 'node:test'

import { formatBytes, formatDuration } from '../src/format.ts'
import { translate } from '../src/i18n.ts'
import { setActiveLocale } from '../src/locale.ts'
import { PROVIDERS } from '../src/providers.ts'

test('translates interface labels into both languages', () => {
  assert.equal(translate('ru', 'nav.map'), 'Карта')
  assert.equal(translate('en', 'nav.map'), 'Map')
  assert.equal(translate('en', 'shortcuts.palette'), 'Command palette')
  assert.equal(translate('ru', 'shortcuts.palette'), 'Командная палитра')
})

test('formatters and provider copy follow the active locale', () => {
  setActiveLocale('en')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatDuration(90), '2 min')
  assert.match(PROVIDERS[0].description, /classic road map/i)
  setActiveLocale('ru')
  assert.equal(formatBytes(2048), '2.0 КБ')
  assert.equal(formatDuration(90), '2 мин')
  assert.match(PROVIDERS[0].description, /дорожная карта/i)
})

test('russian labels never contain english placeholders', () => {
  for (const key of [
    'hud.edit',
    'hud.select',
    'download.queue',
    'settings.language',
  ] as const) {
    assert.ok(translate('ru', key).length > 1)
    assert.notEqual(translate('ru', key), translate('en', key))
  }
})
