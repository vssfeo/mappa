import assert from 'node:assert/strict'
import test from 'node:test'

import { useAppStore } from '../src/store.ts'

const marker = {
  id: 'm1',
  name: 'Исходная',
  lon: 37.6,
  lat: 55.7,
}

test('undo and redo restore markers and collapse rapid edits', () => {
  useAppStore.setState({
    markers: [],
    features: [],
    vectorLayers: [],
    history: [],
    future: [],
    selectedMarkerId: null,
  })
  const store = useAppStore.getState()
  store.clearHistory()
  store.addMarker({ ...marker })
  store.updateMarker('m1', { name: 'Первая' })
  store.updateMarker('m1', { name: 'Вторая' })

  assert.equal(useAppStore.getState().markers[0].name, 'Вторая')
  assert.equal(useAppStore.getState().history.length, 2)

  useAppStore.getState().undo()
  assert.equal(useAppStore.getState().markers[0].name, 'Исходная')
  useAppStore.getState().undo()
  assert.equal(useAppStore.getState().markers.length, 0)
  assert.equal(useAppStore.getState().future.length, 2)

  useAppStore.getState().redo()
  assert.equal(useAppStore.getState().markers.length, 1)
  useAppStore.getState().redo()
  assert.equal(useAppStore.getState().markers[0].name, 'Вторая')
  assert.equal(useAppStore.getState().future.length, 0)
  useAppStore.getState().clearHistory()
})
