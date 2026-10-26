/** Ready-made third-party layers with an explicit licence warning. */

import type { CustomSourceDraft } from './customSources'

export interface ProviderPreset {
  key: string
  name: string
  group: string
  draft: Omit<CustomSourceDraft, 'id'>
}

const yandexHeaders = {
  Referer: 'https://yandex.ru/maps/',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
}

const google = (name: string, layer: string, format: string): ProviderPreset => ({
  key: `google-${layer}`,
  name,
  group: 'Google',
  draft: {
    name,
    kind: 'xyz',
    url: `https://mt1.google.com/vt/lyrs=${layer}&x={x}&y={y}&z={z}`,
    scheme: 'xyz',
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    format,
    attribution: '© Google',
    headers: {},
    rps: 4,
    burst: 8,
    offlineAllowed: false,
  },
})

const esri = (name: string, service: string): ProviderPreset => ({
  key: `esri-${service}`,
  name,
  group: 'Esri',
  draft: {
    name,
    kind: 'xyz',
    url: `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`,
    scheme: 'xyz',
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    format: 'jpg',
    attribution: '© Esri',
    headers: {},
    rps: 4,
    burst: 8,
    offlineAllowed: false,
  },
})

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'yandex-map',
    name: 'Yandex Map',
    group: 'Yandex',
    draft: {
      name: 'Yandex Map',
      kind: 'xyz',
      url: 'https://core-renderer-tiles.maps.yandex.net/tiles?l=map&x={x}&y={y}&z={z}&scale=1&lang=ru_RU',
      scheme: 'xyz',
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      format: 'png',
      attribution: '© Яндекс',
      headers: yandexHeaders,
      rps: 4,
      burst: 8,
      offlineAllowed: false,
    },
  },
  {
    key: 'yandex-satellite',
    name: 'Yandex Satellite',
    group: 'Yandex',
    draft: {
      name: 'Yandex Satellite',
      kind: 'xyz',
      url: 'https://sat01.maps.yandex.net/tiles?l=sat&v=3.0.0&x={x}&y={y}&z={z}&lang=ru_RU',
      scheme: 'xyz',
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      format: 'jpg',
      attribution: '© Яндекс',
      headers: yandexHeaders,
      rps: 4,
      burst: 8,
      offlineAllowed: false,
    },
  },
  google('Google Map', 'm', 'png'),
  google('Google Satellite', 's', 'jpg'),
  google('Google Hybrid', 'y', 'jpg'),
  google('Google Terrain', 'p', 'jpg'),
  esri('Esri Imagery', 'World_Imagery'),
  esri('Esri Streets', 'World_Street_Map'),
  esri('Esri Topo', 'World_Topo_Map'),
]
