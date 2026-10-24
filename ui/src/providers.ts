import { tr } from './locale.ts'

export type ProviderId = 'osm' | 'osm-de' | 'topo' | 'carto' | 'usgs'

export interface Provider {
  id: ProviderId
  label: string
  short: string
  description: string
  tiles: string[]
  attribution: string
  terms: string
  maxZoom: number
  tileSize: number
  /** Whether the provider permits pre-fetching tiles for offline use. */
  offlineAllowed: boolean
}

export const PROVIDERS: Provider[] = [
  {
    id: 'osm',
    label: 'OpenStreetMap',
    short: 'OSM',
    get description() {
      return tr(
        'Классическая дорожная карта. Хорошо читается в городе и в поле.',
        'The classic road map. Easy to read in town and in the field.',
      )
    },
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap contributors',
    terms: 'https://www.openstreetmap.org/copyright',
    maxZoom: 19,
    tileSize: 256,
    offlineAllowed: false,
  },
  {
    id: 'osm-de',
    label: 'OSM Germany',
    short: 'OSM-DE',
    get description() {
      return tr(
        'Зеркало OSM от немецкого сообщества. Выручает, когда основной сервер блокирует запросы.',
        'An OSM mirror run by the German community. Useful when the main server blocks requests.',
      )
    },
    tiles: ['https://tile.openstreetmap.de/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap contributors',
    terms: 'https://www.openstreetmap.org/copyright',
    maxZoom: 19,
    tileSize: 256,
    offlineAllowed: false,
  },
  {
    id: 'topo',
    label: 'OpenTopoMap',
    short: 'TOPO',
    get description() {
      return tr(
        'Топография, рельеф и горизонтали. Полезна для походов и планирования.',
        'Topography, relief and contour lines. Useful for hiking and planning.',
      )
    },
    tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenTopoMap, © OpenStreetMap contributors',
    terms: 'https://opentopomap.org/about',
    maxZoom: 17,
    tileSize: 256,
    offlineAllowed: false,
  },
  {
    id: 'carto',
    label: 'CARTO Dark',
    short: 'DARK',
    get description() {
      return tr(
        'Тёмная минималистичная подложка для ночной работы и презентаций.',
        'A dark minimalist basemap for night work and presentations.',
      )
    },
    tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap contributors, © CARTO',
    terms: 'https://carto.com/attributions',
    maxZoom: 20,
    tileSize: 256,
    offlineAllowed: false,
  },
  {
    id: 'usgs',
    label: 'USGS Imagery',
    short: 'USGS',
    get description() {
      return tr(
        'Спутниковые снимки The National Map. Public domain, разрешено офлайн-скачивание.',
        'Satellite imagery from The National Map. Public domain, offline download allowed.',
      )
    },
    tiles: [
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution: 'USGS The National Map',
    terms: 'https://www.usgs.gov/programs/national-geospatial-program/national-map',
    maxZoom: 19,
    tileSize: 256,
    offlineAllowed: true,
  },
]

export const providerById = (id: ProviderId): Provider =>
  PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[0]
