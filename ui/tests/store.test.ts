import assert from 'node:assert/strict'
import test from 'node:test'

import type { DemInfo } from '../src/dem.ts'
import { distance, polygonArea } from '../src/geo.ts'
import { useAppStore, type PackLayer } from '../src/store.ts'
import type { VectorLayer } from '../src/vectorLayers.ts'

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

test('layer order follows the map stack and pack paths stay in sync', () => {
  const vector = (id: string): VectorLayer => ({
    id,
    name: id,
    format: 'geojson',
    features: [],
    style: { color: '#ffffff', lineWidth: 1, fillOpacity: 0.2, pointRadius: 3 },
    visible: true,
    opacity: 1,
    source: null,
  })
  const pack = (id: string): PackLayer => ({
    id,
    name: id,
    path: `/maps/${id}.mbtiles`,
    kind: 'mbtiles',
    format: 'png',
    minZoom: 0,
    maxZoom: 12,
    west: 30,
    south: 44,
    east: 36,
    north: 46,
    attribution: null,
    tiles: 10,
    visible: true,
    opacity: 1,
  })
  useAppStore.setState({ vectorLayers: [], packs: [], packPaths: [] })
  const store = useAppStore.getState()
  for (const id of ['a', 'b', 'c']) store.addVectorLayer(vector(id))
  store.moveVectorLayer('a', 1)
  assert.deepEqual(
    useAppStore.getState().vectorLayers.map((layer) => layer.id),
    ['b', 'a', 'c'],
  )
  store.moveVectorLayer('c', -1)
  assert.deepEqual(
    useAppStore.getState().vectorLayers.map((layer) => layer.id),
    ['b', 'c', 'a'],
  )
  store.reorderVectorLayers(['c', 'a', 'b'])
  assert.deepEqual(
    useAppStore.getState().vectorLayers.map((layer) => layer.id),
    ['c', 'a', 'b'],
  )
  store.reorderVectorLayers(['a'])
  assert.deepEqual(
    useAppStore.getState().vectorLayers.map((layer) => layer.id),
    ['c', 'a', 'b'],
  )

  useAppStore.setState({ packs: [], packPaths: [] })
  store.addPack(pack('one'))
  store.addPack(pack('two'))
  store.movePack('one', 1)
  assert.deepEqual(
    useAppStore.getState().packs.map((item) => item.id),
    ['two', 'one'],
  )
  assert.deepEqual(useAppStore.getState().packPaths, [
    '/maps/two.mbtiles',
    '/maps/one.mbtiles',
  ])
  store.reorderPacks(['one', 'two'])
  assert.deepEqual(
    useAppStore.getState().packs.map((item) => item.id),
    ['one', 'two'],
  )
  assert.deepEqual(useAppStore.getState().packPaths, [
    '/maps/one.mbtiles',
    '/maps/two.mbtiles',
  ])
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

test('basemap order accepts only a full provider permutation', () => {
  const order = [
    'osm',
    'osm-de',
    'topo',
    'carto',
    'usgs',
    'esri',
    'nasa',
  ] as const
  useAppStore.setState({ providerOrder: [...order] })
  const store = useAppStore.getState()
  store.moveProvider('nasa', -1)
  assert.deepEqual(useAppStore.getState().providerOrder, [
    'osm',
    'osm-de',
    'topo',
    'carto',
    'usgs',
    'nasa',
    'esri',
  ])
  store.reorderProviders(['nasa', 'esri', 'osm', 'osm-de', 'topo', 'carto', 'usgs'])
  assert.deepEqual(useAppStore.getState().providerOrder, [
    'nasa',
    'esri',
    'osm',
    'osm-de',
    'topo',
    'carto',
    'usgs',
  ])
  store.reorderProviders(['nasa', 'esri'])
  assert.equal(useAppStore.getState().providerOrder.length, 7)
  store.reorderProviders([...order])
  assert.deepEqual(useAppStore.getState().providerOrder, [...order])
})

test('custom raster order follows the source list and drag actions', () => {
  const source = (id: string) => ({
    id,
    name: id,
    kind: 'xyz' as const,
    url: `https://example.org/${id}/{z}/{x}/{y}.png`,
    scheme: 'xyz' as const,
    minZoom: 0,
    maxZoom: 18,
    tileSize: 256,
    format: 'png',
    attribution: '',
    terms: null,
    headers: {},
    rps: 4,
    burst: 8,
    offlineAllowed: false,
  })
  useAppStore.getState().setCustomSources([
    source('a'),
    source('b'),
    source('c'),
  ])
  assert.deepEqual(useAppStore.getState().customSourceOrder, ['a', 'b', 'c'])
  const store = useAppStore.getState()
  store.moveCustomSource('a', 1)
  assert.deepEqual(useAppStore.getState().customSourceOrder, ['b', 'a', 'c'])
  store.reorderCustomSources(['c', 'a', 'b'])
  assert.deepEqual(useAppStore.getState().customSourceOrder, ['c', 'a', 'b'])
  store.reorderCustomSources(['c'])
  assert.deepEqual(useAppStore.getState().customSourceOrder, ['c', 'a', 'b'])
  store.setCustomSources([source('b'), source('c')])
  assert.deepEqual(useAppStore.getState().customSourceOrder, ['c', 'b'])
})

test('DEM state follows the active model and clamps hillshade strength', () => {
  const info: DemInfo = {
    id: 'dem-test',
    name: 'N55E037',
    path: '/tmp/N55E037.hgt',
    format: 'hgt',
    west: 37,
    south: 55,
    east: 38,
    north: 56,
    ncols: 3601,
    nrows: 3601,
    cellSize: 1 / 3601,
    resolutionMeters: 30,
    minElevation: 120,
    maxElevation: 240,
    maxZoom: 12,
  }
  const store = useAppStore.getState()
  store.setDem(info)
  assert.equal(useAppStore.getState().dem?.id, 'dem-test')
  assert.equal(useAppStore.getState().demPath, '/tmp/N55E037.hgt')
  store.toggleDemVisible()
  assert.equal(useAppStore.getState().demVisible, false)
  store.setDem3d(true)
  assert.equal(useAppStore.getState().dem3d, true)
  store.setDemOpacity(2)
  assert.equal(useAppStore.getState().demOpacity, 1)
  store.setDemOpacity(-1)
  assert.equal(useAppStore.getState().demOpacity, 0)
  store.forgetDem()
  assert.equal(useAppStore.getState().dem, null)
  assert.equal(useAppStore.getState().demPath, '')
  assert.equal(useAppStore.getState().dem3d, false)
  store.toggleDemVisible()
})

test('route alert follows a line feature and clamps its corridor', () => {
  useAppStore.setState({
    features: [],
    routeFeatureId: null,
    routeAlert: false,
    routeCorridor: 50,
    selectedFeatureId: null,
  })
  const store = useAppStore.getState()
  store.setRouteCorridor(9999)
  assert.equal(useAppStore.getState().routeCorridor, 1000)
  store.setRouteCorridor(1)
  assert.equal(useAppStore.getState().routeCorridor, 5)
  store.setRouteCorridor(75)
  store.setRouteAlert(true)
  store.addFeatures([
    {
      id: 'route-1',
      name: 'Route',
      kind: 'line',
      coordinates: [
        [37.6, 55.75],
        [37.61, 55.75],
      ],
      color: '#4cc9f0',
    },
  ])
  store.setRouteFeatureId('route-1')
  assert.equal(useAppStore.getState().routeFeatureId, 'route-1')
  store.removeFeature('route-1')
  assert.equal(useAppStore.getState().routeFeatureId, null)
  assert.equal(useAppStore.getState().routeAlert, false)
})
