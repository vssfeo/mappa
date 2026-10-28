import { tr } from './locale.ts'

export type ProviderId =
  | 'osm'
  | 'topo'
  | 'carto'
  | 'usgs'
  | 'esri'
  | 'nasa'

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
  {
    id: 'esri',
    label: 'Esri World Imagery',
    short: 'ESRI',
    get description() {
      return tr(
        'Спутниковые снимки World Imagery: города, дороги и рельеф. Только интерактивный просмотр, без офлайн-загрузки.',
        'World Imagery satellite mosaics: cities, roads and terrain. Interactive viewing only, no offline downloads.',
      )
    },
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution:
      'Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    terms: 'https://www.esri.com/en-us/legal/terms/full-master-agreement',
    maxZoom: 19,
    tileSize: 256,
    offlineAllowed: false,
  },
  {
    id: 'nasa',
    label: 'NASA Blue Marble',
    short: 'NASA',
    get description() {
      return tr(
        'Глобальный снимок Земли NASA Blue Marble с рельефом и батиметрией. Общественное достояние, z0–z8.',
        'NASA Blue Marble global imagery with relief and bathymetry. Public domain, z0–z8.',
      )
    },
    tiles: [
      'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
    ],
    attribution: 'NASA EOSDIS GIBS · Blue Marble',
    terms: 'https://earthdata.nasa.gov/gibs',
    maxZoom: 8,
    tileSize: 256,
    offlineAllowed: true,
  },
]

export const providerById = (id: ProviderId): Provider =>
  PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[0]
