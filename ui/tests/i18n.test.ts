import assert from 'node:assert/strict'
import test from 'node:test'

import { formatBytes, formatDuration } from '../src/format.ts'
import { translate } from '../src/i18n.ts'
import { setActiveLocale, translateText } from '../src/locale.ts'
import { CATALOGS } from '../src/locales/index.ts'
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

test('additional locales translate labels and fall back to english', () => {
  assert.equal(translate('de', 'nav.map'), 'Karte')
  assert.equal(translate('fr', 'nav.map'), 'Carte')
  assert.equal(translate('es', 'nav.map'), 'Mapa')
  assert.equal(translate('de', 'settings.language'), 'Oberflächensprache')
  assert.equal(translate('fr', 'settings.language'), "Langue de l'interface")
  assert.equal(translate('es', 'settings.language'), 'Idioma de la interfaz')
  assert.equal(translateText('de', 'Карта', 'Map'), 'Karte')
  assert.equal(translateText('fr', 'Карта', 'Map'), 'Carte')
  assert.equal(translateText('es', 'Карта', 'Map'), 'Mapa')
  assert.equal(
    translateText('de', 'Карта', 'An untranslated sample'),
    'An untranslated sample',
  )
  const reference = Object.keys(CATALOGS.de).sort()
  assert.ok(reference.length > 700)
  for (const locale of ['de', 'fr', 'es'] as const) {
    const catalog = CATALOGS[locale]
    assert.deepEqual(Object.keys(catalog).sort(), reference)
    assert.ok(Object.values(catalog).every((value) => value.trim().length > 0))
    for (const key of reference) {
      const expected = key.match(/\{\w+\}/g)?.sort() ?? []
      const actual = catalog[key].match(/\{\w+\}/g)?.sort() ?? []
      assert.deepEqual(actual, expected, `${locale}: ${key}`)
    }
  }
})

test('placeholder values are substituted after translation', () => {
  assert.equal(
    translateText(
      'de',
      'Слишком много координат: лимит {p0}',
      'Too many coordinates: the limit is {p0}',
      { p0: '12 000' },
    ),
    'Zu viele Koordinaten: Limit 12 000',
  )
  assert.equal(
    translateText('es', 'Карта', 'Map', { p0: 'ignored' }),
    'Mapa',
  )
})
