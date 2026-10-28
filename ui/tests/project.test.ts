import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildProject,
  defaultProject,
  parseProject,
  serializeProject,
  type ProjectSnapshot,
} from '../src/projectFile.ts'

const CUSTOM_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZ9G9QAAAABJRU5ErkJggg=='

const snapshot = (): ProjectSnapshot => ({
  name: 'Demo region',
  providerId: 'topo',
  view: { center: [34.1, 44.9], zoom: 9 },
  layers: {
    osm: { visible: false, opacity: 0.5 },
    topo: { visible: false, opacity: 0.8 },
  },
  customLayers: { 'custom-demo': { visible: false, opacity: 0.3 } },
  packPaths: ['/home/user/maps/crimea.mbtiles', '/home/user/maps/crimea.mbtiles'],
  demPath: '/home/user/dem/N45E034.hgt',
  markers: [
    { id: 'a', name: 'Балаклава', lon: 33.6, lat: 44.5 },
    { id: 'b', name: 'Феодосия', lon: 35.38, lat: 45.03, elevation: 42.5, description: 'порт', folder: 'Порты', icon: '⚓', iconImage: CUSTOM_ICON, color: '#4cc9f0' },
  ],
  features: [
    {
      id: 'f1',
      name: 'Маршрут',
      kind: 'line',
      coordinates: [
        [33.5, 44.5],
        [34.5, 45.0],
      ],
      color: '#4cc9f0',
      profile: {
        elevations: [12, 850],
        times: ['2026-01-01T10:00:00Z', '2026-01-01T12:00:00Z'],
      },
    },
  ],
  vectorLayers: [
    {
      id: 'vector-demo',
      name: 'Дороги',
      format: 'geojson',
      features: [
        {
          type: 'Feature',
          properties: { name: 'Трасса', lanes: 4 },
          geometry: {
            type: 'LineString',
            coordinates: [
              [34.0, 44.8],
              [34.2, 45.0],
            ],
          },
          profile: {
            elevations: [5, 15],
            times: [null, null],
          },
        },
      ],
      style: {
        color: '#4cc9f0',
        lineWidth: 3,
        fillOpacity: 0.2,
        pointRadius: 5,
      },
      visible: true,
      opacity: 0.8,
      source: '/data/roads.geojson',
    },
  ],
  coordinateFormat: 'dms',
  crs: { epsg: 32637 },
  crsLabel: 'UTM 37N',
})

test('project round-trips through the .mappa format', () => {
  const file = buildProject(snapshot(), '2026-10-23T00:00:00.000Z')
  const parsed = parseProject(serializeProject(file)).file
  assert.equal(parsed.format, 'mappa-project')
  assert.equal(parsed.version, 1)
  assert.equal(parsed.name, 'Demo region')
  assert.equal(parsed.providerId, 'topo')
  assert.equal(parsed.providerOrder[0], 'osm')
  assert.equal(parsed.providerOrder.length, 6)
  assert.deepEqual(parsed.view, { center: [34.1, 44.9], zoom: 9 })
  assert.equal(parsed.packPaths.length, 1)
  assert.equal(parsed.demPath, '/home/user/dem/N45E034.hgt')
  assert.equal(parsed.markers.length, 2)
  assert.equal(parsed.markers[1].folder, 'Порты')
  assert.equal(parsed.markers[1].icon, '⚓')
  assert.equal(parsed.markers[1].color, '#4cc9f0')
  assert.equal(parsed.markers[1].elevation, 42.5)
  assert.equal(parsed.markers[1].iconImage, CUSTOM_ICON)
  assert.equal(parsed.features.features.length, 1)
  assert.deepEqual(
    (parsed.features.features[0].properties as { profile?: unknown }).profile,
    {
      elevations: [12, 850],
      times: ['2026-01-01T10:00:00Z', '2026-01-01T12:00:00Z'],
    },
  )
  assert.equal(parsed.vectorLayers.length, 1)
  assert.equal(parsed.vectorLayers[0].name, 'Дороги')
  assert.equal(parsed.vectorLayers[0].style.color, '#4cc9f0')
  assert.equal(parsed.vectorLayers[0].features[0].properties?.lanes, 4)
  assert.deepEqual(parsed.vectorLayers[0].features[0].profile?.elevations, [
    5, 15,
  ])
  assert.equal(parsed.coordinateFormat, 'dms')
  assert.deepEqual(parsed.crs, { epsg: 32637 })
  // The active basemap must stay visible even if the file hid it.
  assert.equal(parsed.layers.topo.visible, true)
  assert.equal(parsed.layers.topo.opacity, 0.8)
  assert.equal(parsed.layers.osm.visible, false)
  assert.equal(parsed.customLayers['custom-demo'].opacity, 0.3)
})

test('parseProject returns runtime features', () => {
  const parsed = parseProject(serializeProject(buildProject(snapshot())))
  assert.equal(parsed.features.length, 1)
  assert.equal(parsed.features[0].kind, 'line')
  assert.equal(parsed.features[0].coordinates.length, 2)
  assert.deepEqual(parsed.features[0].profile?.elevations, [12, 850])
})

test('rejects unknown formats and broken JSON', () => {
  assert.throws(() => parseProject('{'), /повреждён/)
  assert.throws(() => parseProject('[]'), /повреждён/)
  assert.throws(() => parseProject('{"format":"other","version":1}'), /формат/)
  assert.throws(
    () => parseProject('{"format":"mappa-project","version":2}'),
    /формат/,
  )
})

test('sanitizes untrusted fields and clamps collections', () => {
  const file = buildProject(snapshot())
  const raw = JSON.parse(serializeProject(file))
  raw.providerId = 'nonexistent'
  raw.providerOrder = ['nasa', 'nasa', 'bogus']
  raw.view = { center: [500, 100], zoom: 99 }
  raw.packPaths = ['/valid.mbtiles', '', 42, '/valid.mbtiles']
  raw.demPath = 42
  raw.markers = [
    { id: 'dup', name: 'A', lon: 34, lat: 45 },
    { id: 'dup', name: 'B', lon: 35, lat: 46 },
    { id: 'bad', name: 'C', lon: 300, lat: 45 },
  ]
  raw.crs = { epsg: -1, proj: '' }
  raw.coordinateFormat = 'mgrs2'
  const parsed = parseProject(JSON.stringify(raw)).file
  assert.equal(parsed.providerId, 'osm')
  assert.equal(parsed.providerOrder[0], 'nasa')
  assert.equal(parsed.providerOrder.length, 6)
  assert.deepEqual(parsed.view.center, [37.6173, 55.7558])
  assert.equal(parsed.view.zoom, 24)
  assert.deepEqual(parsed.packPaths, ['/valid.mbtiles'])
  assert.equal(parsed.demPath, '')
  assert.equal(parsed.markers.length, 2)
  assert.notEqual(parsed.markers[0].id, parsed.markers[1].id)
  assert.equal(parsed.crs, null)
  assert.equal(parsed.coordinateFormat, 'dd')
  assert.equal(parsed.layers.osm.visible, true)
})

test('accepts a custom proj4 CRS', () => {
  const raw = JSON.parse(serializeProject(buildProject(snapshot())))
  raw.crs = { proj: '+proj=utm +zone=37 +datum=WGS84 +units=m +no_defs' }
  const parsed = parseProject(JSON.stringify(raw)).file
  assert.equal(parsed.crs?.proj?.includes('+proj=utm'), true)
})

test('default project is a valid empty workspace', () => {
  const project = defaultProject('Новый')
  assert.equal(project.name, 'Новый')
  assert.equal(project.packPaths.length, 0)
  assert.equal(project.markers.length, 0)
  assert.equal(project.features.features.length, 0)
  assert.equal(project.layers[project.providerId].visible, true)
})
