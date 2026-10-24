import assert from 'node:assert/strict'
import test from 'node:test'

import { distance, polygonArea } from '../src/geo.ts'
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

test('drawing a circle stores a round polygon with its radius', () => {
  useAppStore.setState({
    features: [],
    draftPoints: [],
    history: [],
    future: [],
    featureMode: 'off',
  })
  const store = useAppStore.getState()
  store.clearHistory()
  store.setFeatureMode('draw-circle')
  const center: [number, number] = [37.6, 55.7]
  const edge: [number, number] = [37.62, 55.7]
  store.addDraftPoint(center)
  store.addDraftPoint(edge)
  store.finishDraft()

  const feature = useAppStore.getState().features[0]
  assert.equal(feature.kind, 'polygon')
  assert.equal(feature.name, 'Круг 1')
  assert.equal(feature.coordinates.length, 64)
  const radius = distance(center, edge)
  assert.ok(Math.abs(polygonArea(feature.coordinates) - Math.PI * radius ** 2) / (Math.PI * radius ** 2) < 0.01)
  assert.equal(useAppStore.getState().draftPoints.length, 0)
  assert.equal(useAppStore.getState().featureMode, 'off')
  useAppStore.getState().clearHistory()
})
