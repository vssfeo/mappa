/**
 * Minimal KMZ reader: finds the first KML entry in a ZIP container.
 *
 * Only stored and deflated members are supported, which covers every KMZ
 * exporter in practice. Sizes and entry counts are bounded before allocating,
 * and the document stays far away from the DOM until it is decoded.
 */

import { tr } from './locale.ts'

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const MAX_KML_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 10_000
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

interface Entry {
  name: string
  method: number
  compressed: number
  uncompressed: number
  localOffset: number
}

const fail = (message: string): never => {
  throw new Error(message)
}

export async function readKmz(buffer: ArrayBuffer): Promise<string> {
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) {
    fail(
      tr(
        'KMZ больше {p0} МиБ и не будет открыт',
        'The KMZ is larger than {p0} MiB and will not be opened',
        { p0: MAX_ARCHIVE_BYTES / 1024 / 1024 },
      ),
    )
  }
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const need = (offset: number, length: number) => {
    if (offset < 0 || length < 0 || offset + length > bytes.length) {
      fail(tr('Повреждённый KMZ: запись выходит за границы файла', 'Damaged KMZ: an entry extends past the end of the file'))
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
  if (eocd < 0) fail(tr('Файл не является ZIP/KMZ', 'The file is not a ZIP/KMZ'))

  const entries = view.getUint16(eocd + 10, true)
  const centralSize = view.getUint32(eocd + 12, true)
  const centralOffset = view.getUint32(eocd + 16, true)
  if (entries === 0xffff || centralOffset === 0xffffffff) {
    fail(tr('ZIP64 в KMZ не поддерживается', 'ZIP64 inside KMZ is not supported'))
  }
  if (entries > MAX_ENTRIES) {
    fail(tr(
           'В KMZ больше {p0} записей',
           'The KMZ has more than {p0} entries',
           { p0: MAX_ENTRIES },
         ))
  }
  need(centralOffset, centralSize)

  const decoder = new TextDecoder('utf-8')
  let cursor = centralOffset
  let candidate: Entry | null = null
  for (let index = 0; index < entries; index += 1) {
    need(cursor, 46)
    if (view.getUint32(cursor, true) !== CENTRAL) {
      fail(tr('Повреждённый KMZ: неверный центральный каталог', 'Damaged KMZ: invalid central directory'))
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
    const name = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    )
    cursor += 46 + nameLength + extraLength + commentLength

    if (
      flags & 0x1 ||
      !name.toLowerCase().endsWith('.kml') ||
      name.startsWith('__MACOSX/') ||
      name.endsWith('/')
    ) {
      continue
    }
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) continue
    const entry = { name, method, compressed, uncompressed, localOffset }
    const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase()
    if (base === 'doc.kml') {
      candidate = entry
      break
    }
    candidate ??= entry
  }
  if (!candidate) throw new Error(tr('В KMZ не найден файл .kml', 'No .kml file found in the KMZ'))
  if (candidate.uncompressed > MAX_KML_BYTES) {
    fail(tr('KML внутри KMZ слишком большой', 'The KML inside the KMZ is too large'))
  }

  need(candidate.localOffset, 30)
  if (view.getUint32(candidate.localOffset, true) !== LOCAL) {
    fail(tr('Повреждённый KMZ: неверный локальный заголовок', 'Damaged KMZ: invalid local header'))
  }
  const nameLength = view.getUint16(candidate.localOffset + 26, true)
  const extraLength = view.getUint16(candidate.localOffset + 28, true)
  const start = candidate.localOffset + 30 + nameLength + extraLength
  need(start, candidate.compressed)
  const raw = bytes.slice(start, start + candidate.compressed)

  let data: Uint8Array
  if (candidate.method === 0) {
    data = raw
  } else if (candidate.method === 8) {
    data = await inflateRaw(raw)
  } else {
    throw new Error(tr(
                      'Сжатие ZIP {p0} не поддерживается',
                      'ZIP compression {p0} is not supported',
                      { p0: candidate.method },
                    ))
  }
  if (data.byteLength > MAX_KML_BYTES) fail(tr('KML внутри KMZ слишком большой', 'The KML inside the KMZ is too large'))

  if (data[0] === 0xff && data[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(data.subarray(2))
  }
  if (data[0] === 0xfe && data[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(data.subarray(2))
  }
  return new TextDecoder('utf-8').decode(data)
}

type DecompressionStreamConstructor = new (
  format: string,
) => TransformStream<Uint8Array, Uint8Array>

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const Constructor = (
    globalThis as { DecompressionStream?: DecompressionStreamConstructor }
  ).DecompressionStream
  if (!Constructor) {
    throw new Error(tr('WebView не поддерживает распаковку KMZ', 'This WebView cannot unpack KMZ'))
  }
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new Constructor('deflate-raw'))
  const unpacked = await new Response(stream).arrayBuffer()
  return new Uint8Array(unpacked)
}
