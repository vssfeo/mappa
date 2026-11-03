import assert from 'node:assert/strict'
import test from 'node:test'
import { createStoredZip } from '../src/zip.ts'
import { parseSasZip } from '../src/sasLayers.ts'

const encoder = new TextEncoder()

function archive(params: string): ArrayBuffer {
  const zip = createStoredZip([
    { name: '_NSPD/1.test.zmp/params.txt', data: encoder.encode(params) },
  ])
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer
}

test('reads a zmp WMS layer and rewrites the BBOX placeholder', async () => {
  const params = [
    '[PARAMS]',
    'NameInCache=1.test',
    'name=Cadastral districts',
    'ParentSubMenu=NSPD\\Cadastre',
    'DefURLBase=https://nspd.gov.ru/api/aeggis/v4/1/wms?REQUEST=GetMap&SERVICE=WMS&VERSION=1.3.0&FORMAT=image%2Fpng&LAYERS=1&WIDTH=256&HEIGHT=256&CRS=EPSG%3A3857&BBOX=',
    'Ext=.png',
    'RequestHead=Referer:https://nspd.gov.ru/map',
  ].join('\n')
  const layers = await parseSasZip(archive(params))
  assert.equal(layers.length, 1)
  const layer = layers[0]
  assert.equal(layer.name, 'Cadastral districts')
  assert.equal(layer.group, 'NSPD / Cadastre')
  assert.ok(layer.url.endsWith('BBOX={bbox-epsg-3857}'))
  assert.equal(layer.headers.Referer, 'https://nspd.gov.ru/map')
  assert.equal(layer.insecureTls, true)
  assert.equal(layer.format, 'png')
})

test('ignores non-GetMap definitions', async () => {
  const params = [
    '[PARAMS]',
    'name=Plain',
    'DefURLBase=https://example.org/{z}/{x}/{y}.png',
  ].join('\n')
  await assert.rejects(parseSasZip(archive(params)), /no \.zmp layers|нет слоёв/)
})
