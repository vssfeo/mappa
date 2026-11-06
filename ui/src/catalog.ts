/** Static pack catalog: metadata only, packs are transferred by torrent. */

export const DEFAULT_CATALOG_URL =
  'https://raw.githubusercontent.com/vssfeo/mappa/main/catalog/catalog.json'

export interface CatalogPack {
  id: string
  name: string
  bbox: [number, number, number, number]
  zoom: [number, number]
  provider: string
  bytes: number
  infoHash: string
  magnet: string
  license: string
  publisher: string
  publishedAt: string
}

export interface Catalog {
  format: 'mappa-catalog'
  version: 1
  updatedAt: string
  packs: CatalogPack[]
}

export async function fetchCatalog(url: string): Promise<Catalog> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`catalog HTTP ${response.status}`)
  }
  const data = (await response.json()) as Catalog
  if (data.format !== 'mappa-catalog' || !Array.isArray(data.packs)) {
    throw new Error('not a Mappa catalog')
  }
  return data
}

const intersects = (
  a: [number, number, number, number],
  b: [number, number, number, number],
) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]

export function filterPacks(
  packs: CatalogPack[],
  options: {
    bounds: [[number, number], [number, number]] | null
    zoom: number
    provider?: string
    query?: string
    onlyVisible?: boolean
  },
): CatalogPack[] {
  const query = (options.query ?? '').trim().toLowerCase()
  const bounds = options.bounds
    ? [
        options.bounds[0][0],
        options.bounds[0][1],
        options.bounds[1][0],
        options.bounds[1][1],
      ] as [number, number, number, number]
    : null
  return packs.filter((pack) => {
    if (options.provider && pack.provider !== options.provider) return false
    if (query && !`${pack.name} ${pack.publisher} ${pack.license}`.toLowerCase().includes(query)) {
      return false
    }
    if (options.zoom < pack.zoom[0] || options.zoom > pack.zoom[1]) return false
    if (options.onlyVisible && bounds && !intersects(pack.bbox, bounds)) return false
    return true
  })
}

export interface CatalogEntryOptions {
  pack: {
    name: string
    west: number
    south: number
    east: number
    north: number
    minZoom: number
    maxZoom: number
    bytes: number
  }
  provider: string
  infoHash: string
  magnet: string
  license: string
  publisher: string
}

export function catalogEntry(options: CatalogEntryOptions): CatalogPack {
  const { pack } = options
  const slug = pack.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return {
    id: `${slug || 'pack'}-${options.infoHash.slice(0, 8)}`,
    name: pack.name,
    bbox: [pack.west, pack.south, pack.east, pack.north],
    zoom: [pack.minZoom, pack.maxZoom],
    provider: options.provider,
    bytes: pack.bytes,
    infoHash: options.infoHash,
    magnet: options.magnet,
    license: options.license,
    publisher: options.publisher,
    publishedAt: new Date().toISOString(),
  }
}


/** GitHub issue URL with the entry prefilled, for the catalog PR workflow. */
export function catalogIssueUrl(
  entry: CatalogPack,
  repository = 'vssfeo/mappa',
): string {
  const title = `catalog: ${entry.name}`
  const body = [
    'Добавить пак в статический каталог.',
    '',
    '`catalog/catalog.json` → `packs[]`:',
    '',
    '```json',
    JSON.stringify(entry, null, 2),
    '```',
    '',
    'Проверьте лицензию и что торрент сидируется.',
  ].join('\n')
  return `https://github.com/${repository}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
}
