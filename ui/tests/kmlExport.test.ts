import assert from 'node:assert/strict'
import test from 'node:test'

import { vectorLayerToKml } from '../src/kmlExport.ts'
import { parseVectorText } from '../src/vectorLayers.ts'

test('writes features, attributes and layer style as KML', () => {
  const kml = vectorLayerToKml({
    id: 'vector-1',
    name: 'Дороги & реки',
    format: 'geojson',
    style: {
      color: '#4cc9f0',
      lineWidth: 2.5,
      fillOpacity: 0.2,
      pointRadius: 4,
    },
    visible: true,
    opacity: 0.8,
    source: null,
    features: [
      {
        type: 'Feature',
        properties: { name: 'Трасса <A>', lanes: 4 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [34.1, 44.9],
            [34.2, 45],
          ],
        },
      },
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [34, 44],
              [34.2, 44],
              [34.2, 44.2],
              [34, 44],
            ],
          ],
        },
      },
    ],
  })
  assert.match(kml, /<kml xmlns="http:\/\/www.opengis.net\/kml\/2.2">/)
  assert.match(kml, /Дороги &amp; реки/)
  assert.match(kml, /Трасса &lt;A&gt;/)
  assert.match(kml, /<LineString>/)
  assert.match(kml, /<outerBoundaryIs>/)
  assert.match(kml, /<Data name="lanes"><value>4<\/value><\/Data>/)
  assert.match(kml, /<color>ccf0c94c<\/color>/)
  assert.equal(parseVectorText(kml, 'kml').features.length, 2)
})
