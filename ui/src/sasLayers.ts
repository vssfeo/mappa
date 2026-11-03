/**
 * SAS.Planet `.zmp` layer definitions.
 *
 * A `.zmp` folder holds `params.txt` with a WMS GetMap URL and request
 * headers. The archive in the wild is a ZIP of such folders; this module
 * reads the definitions only, never the tile cache.
 */

import { open } from '@tauri-apps/plugin-dialog'
import { readBinaryFile } from './native.ts'
import { tr } from './locale.ts'
import { inflateRaw } from './kmz.ts'

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const MAX_ENTRIES = 10_000
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const MAX_PARAMS_BYTES = 256 * 1024

export interface SasLayer {
  id: string
  name: string
  group: string
  url: string
  format: string
  headers: Record<string, string>
  attribution: string
  insecureTls: boolean
}

interface Entry {
  name: string
  method: number
  compressed: number
  uncompressed: number
  localOffset: number
}

/** Opens a ZIP with SAS `.zmp` folders and returns their layer definitions. */
export async function importSasLayers(): Promise<SasLayer[] | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title: tr('Импорт слоёв SAS.Planet', 'Import SAS.Planet layers'),
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  })
  const path = Array.isArray(selected) ? selected[0] : selected
  if (typeof path !== 'string' || path.length === 0) return null
  return parseSasZip(await readBinaryFile(path))
}

export async function parseSasZip(buffer: ArrayBuffer): Promise<SasLayer[]> {
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(tr('Архив SAS больше 256 МиБ', 'The SAS archive is larger than 256 MiB'))
  }
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const need = (offset: number, length: number) => {
    if (offset < 0 || length < 0 || offset + length > bytes.length) {
      throw new Error(tr('Повреждённый ZIP', 'Damaged ZIP'))
    }
  }
  let eocd = -1
  const floor = Math.max(0, bytes.length - 65_557)
  for (let offset = bytes.length - 22; offset >= floor; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error(tr('Файл не является ZIP', 'The file is not a ZIP'))
  const count = view.getUint16(eocd + 10, true)
  const centralSize = view.getUint32(eocd + 12, true)
  const centralOffset = view.getUint32(eocd + 16, true)
  if (count === 0xffff || centralOffset === 0xffffffff) {
    throw new Error(tr('ZIP64 не поддерживается', 'ZIP64 is not supported'))
  }
  if (count > MAX_ENTRIES) throw new Error(tr('Слишком много файлов в архиве', 'Too many files in the archive'))
  need(centralOffset, centralSize)

  const decoder = new TextDecoder('utf-8')
  const entries: Entry[] = []
  let cursor = centralOffset
  for (let index = 0; index < count; index += 1) {
    need(cursor, 46)
    if (view.getUint32(cursor, true) !== CENTRAL) {
      throw new Error(tr('Повреждённый центральный каталог ZIP', 'Damaged ZIP central directory'))
    }
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const compressed = view.getUint32(cursor + 20, true)
    const uncompressed = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    need(cursor + 46, nameLength)
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    cursor += 46 + nameLength + extraLength + commentLength
    if (flags & 0x1 || !name.toLowerCase().endsWith('/params.txt')) continue
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) continue
    entries.push({ name, method, compressed, uncompressed, localOffset })
  }

  const layers: SasLayer[] = []
  for (const entry of entries) {
    const text = await readEntry(bytes, view, entry, need)
    const layer = parseParams(text, entry.name)
    if (layer) layers.push(layer)
  }
  if (layers.length === 0) {
    throw new Error(tr('В архиве нет слоёв .zmp', 'The archive contains no .zmp layers'))
  }
  return layers
}

async function readEntry(
  bytes: Uint8Array,
  view: DataView,
  entry: Entry,
  need: (offset: number, length: number) => void,
): Promise<string> {
  if (entry.uncompressed > MAX_PARAMS_BYTES) {
    throw new Error(tr('params.txt слишком большой', 'params.txt is too large'))
  }
  need(entry.localOffset, 30)
  if (view.getUint32(entry.localOffset, true) !== LOCAL) {
    throw new Error(tr('Повреждённый локальный заголовок ZIP', 'Damaged ZIP local header'))
  }
  const nameLength = view.getUint16(entry.localOffset + 26, true)
  const extraLength = view.getUint16(entry.localOffset + 28, true)
  const start = entry.localOffset + 30 + nameLength + extraLength
  need(start, entry.compressed)
  const raw = bytes.slice(start, start + entry.compressed)
  const data = entry.method === 0 ? raw : entry.method === 8 ? await inflateRaw(raw) : null
  if (!data) throw new Error(tr('Сжатие ZIP {p0} не поддерживается', 'ZIP compression {p0} is not supported', { p0: entry.method }))
  return new TextDecoder('windows-1251').decode(data)
}

function field(text: string, key: string): string | undefined {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(text)
  return match?.[1]?.trim()
}

function parseParams(text: string, path: string): SasLayer | null {
  const name = field(text, 'name')
  const nameInCache = field(text, 'NameInCache')
  const rawUrl = field(text, 'DefURLBase')
  if (!name || !rawUrl || !/REQUEST=GetMap/i.test(rawUrl)) return null
  const url = rawUrl.replace(/BBOX=\s*$/i, 'BBOX={bbox-epsg-3857}')
  if (!url.includes('{bbox-epsg-3857}')) return null
  const headers: Record<string, string> = {}
  const requestHead = field(text, 'RequestHead')
  if (requestHead) {
    for (const line of requestHead.split(/\r?\n/)) {
      const index = line.indexOf(':')
      if (index <= 0) continue
      const key = line.slice(0, index).trim()
      const value = line.slice(index + 1).trim()
      if (key && value) headers[key] = value
    }
  }
  const stem = (nameInCache || path.split('/').slice(-2)[0] || name)
    .replace(/\.zmp$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
  const id = `sas-${stem}`.slice(0, 48)
  const parents = (field(text, 'ParentSubMenu') ?? '').split('\\').filter(Boolean)
  const group = parents[0] === 'НСПД' ? parents.slice(1).join(' / ') : parents.join(' / ')
  const format = (field(text, 'Ext') ?? 'png').replace(/^\./, '').toLowerCase()
  const insecureTls = /(^|\.)nspd\.gov\.ru$/i.test(new URL(url).hostname)
  return {
    id,
    name,
    group,
    url,
    format,
    headers,
    attribution: insecureTls ? 'НСПД / Росреестр' : 'SAS.Planet',
    insecureTls,
  }
}
