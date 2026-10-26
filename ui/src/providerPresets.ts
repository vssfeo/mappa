/** Ready-made third-party layers with an explicit licence warning. */

import type { CustomSourceDraft } from './customSources'

export interface ProviderPreset {
  key: string
  name: string
  draft: Omit<CustomSourceDraft, 'id'>
}

const browserHeaders = {
  Referer: 'https://yandex.ru/maps/',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'yandex-map',
    name: 'Yandex Map',
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
      headers: browserHeaders,
      rps: 4,
      burst: 8,
      offlineAllowed: false,
    },
  },
  {
    key: 'yandex-satellite',
    name: 'Yandex Satellite',
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
      headers: browserHeaders,
      rps: 4,
      burst: 8,
      offlineAllowed: false,
    },
  },
]
