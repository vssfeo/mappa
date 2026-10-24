/** Minimal ZIP writer for KMZ exports (stored entries, no compression). */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  name: string
  data: Uint8Array
}

/** Builds a standard ZIP archive with uncompressed entries. */
export function createStoredZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const prepared = entries.map((entry) => ({
    name: encoder.encode(entry.name),
    data: entry.data,
    crc: crc32(entry.data),
  }))
  const localSize = prepared.reduce(
    (sum, entry) => sum + 30 + entry.name.length + entry.data.length,
    0,
  )
  const centralSize = prepared.reduce(
    (sum, entry) => sum + 46 + entry.name.length,
    0,
  )
  const archive = new Uint8Array(localSize + centralSize + 22)
  const view = new DataView(archive.buffer)
  let offset = 0
  const offsets: number[] = []
  for (const entry of prepared) {
    offsets.push(offset)
    view.setUint32(offset, 0x04034b50, true)
    view.setUint16(offset + 4, 20, true)
    view.setUint16(offset + 6, 0x0800, true) // UTF-8 names
    view.setUint16(offset + 8, 0, true) // stored
    view.setUint32(offset + 14, entry.crc, true)
    view.setUint32(offset + 18, entry.data.length, true)
    view.setUint32(offset + 22, entry.data.length, true)
    view.setUint16(offset + 26, entry.name.length, true)
    archive.set(entry.name, offset + 30)
    archive.set(entry.data, offset + 30 + entry.name.length)
    offset += 30 + entry.name.length + entry.data.length
  }
  const centralStart = offset
  prepared.forEach((entry, index) => {
    view.setUint32(offset, 0x02014b50, true)
    view.setUint16(offset + 4, 20, true)
    view.setUint16(offset + 6, 20, true)
    view.setUint16(offset + 8, 0x0800, true)
    view.setUint16(offset + 10, 0, true)
    view.setUint32(offset + 16, entry.crc, true)
    view.setUint32(offset + 20, entry.data.length, true)
    view.setUint32(offset + 24, entry.data.length, true)
    view.setUint16(offset + 28, entry.name.length, true)
    view.setUint32(offset + 42, offsets[index], true)
    archive.set(entry.name, offset + 46)
    offset += 46 + entry.name.length
  })
  view.setUint32(offset, 0x06054b50, true)
  view.setUint16(offset + 8, prepared.length, true)
  view.setUint16(offset + 10, prepared.length, true)
  view.setUint32(offset + 12, centralSize, true)
  view.setUint32(offset + 16, centralStart, true)
  return archive
}
