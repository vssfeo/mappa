import assert from 'node:assert/strict'
import test from 'node:test'
import { geocodeSearch } from '../src/geocode.ts'

test('browser build reports that place search is native-only', async () => {
  const result = await geocodeSearch('Москва', 'ru')
  assert.deepEqual(result, {
    places: [],
    online: false,
    warning: 'native_only',
  })
})
