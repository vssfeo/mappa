/** One-page PDF writer with a JPEG map image and print margins. */

interface PdfObject {
  bytes: Uint8Array
}

export interface PdfPrintOptions {
  /** Printed above the map; non-ASCII characters become `?`. */
  title?: string
  /** Printed below the map (scale, CRS and date). */
  footer?: string
}

const pdfText = (value: string): string =>
  value
    .replace(/[\\()]/g, (character) => `\\${character}`)
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, 240)

export const latin1 = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0) & 0xff)

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function pdfObject(id: number, body: Uint8Array): PdfObject {
  return {
    bytes: concat([
      latin1(`${id} 0 obj\n`),
      body,
      latin1('\nendobj\n'),
    ]),
  }
}

export function buildPdf(
  jpeg: Uint8Array,
  width: number,
  height: number,
  options: PdfPrintOptions = {},
): Uint8Array {
  const landscape = width >= height
  const pageWidth = landscape ? 842 : 595
  const pageHeight = landscape ? 595 : 842
  const margin = 28
  const headerHeight = 30
  const footer = 24
  const availableWidth = pageWidth - margin * 2
  const availableHeight = pageHeight - margin * 2 - headerHeight - footer
  const scale = Math.min(availableWidth / width, availableHeight / height)
  const drawWidth = width * scale
  const drawHeight = height * scale
  const x = (pageWidth - drawWidth) / 2
  const y = margin + footer + (availableHeight - drawHeight) / 2
  const printTitle = pdfText(options.title ?? 'Mappa map')
  const printFooter = pdfText(options.footer ?? '')
  const content = latin1(
    [
      'q',
      `${drawWidth.toFixed(3)} 0 0 ${drawHeight.toFixed(3)} ${x.toFixed(3)} ${y.toFixed(3)} cm`,
      '/Im0 Do',
      'Q',
      '0.65 w 0.4 0.4 0.4 RG',
      `${x.toFixed(3)} ${y.toFixed(3)} ${drawWidth.toFixed(3)} ${drawHeight.toFixed(3)} re S`,
      'BT',
      '/F1 11 Tf 0.15 0.18 0.22 rg',
      `${margin} ${(pageHeight - margin - 9).toFixed(3)} Td`,
      `(${printTitle}) Tj`,
      ...(printFooter
        ? [
            'ET',
            'BT',
            '/F1 8 Tf 0.42 0.45 0.5 rg',
            `${margin} ${(margin - 9).toFixed(3)} Td`,
            `(${printFooter}) Tj`,
          ]
        : []),
      'ET',
      '',
    ].join('\n'),
  )
  const objects: PdfObject[] = [
    pdfObject(1, latin1('<< /Type /Catalog /Pages 2 0 R >>')),
    pdfObject(2, latin1('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')),
    pdfObject(
      3,
      latin1(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> /Font << /F1 6 0 R >> >> /Contents 5 0 R >>`,
      ),
    ),
    pdfObject(
      4,
      concat([
        latin1(
          `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        ),
        jpeg,
        latin1('\nendstream'),
      ]),
    ),
    pdfObject(
      5,
      concat([
        latin1(`<< /Length ${content.length} >>\nstream\n`),
        content,
        latin1('endstream'),
      ]),
    ),
    pdfObject(
      6,
      latin1(
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      ),
    ),
  ]
  const header = concat([
    latin1('%PDF-1.4\n'),
    Uint8Array.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]),
  ])
  const parts: Uint8Array[] = [header]
  let offset = header.length
  const offsets: number[] = []
  for (const object of objects) {
    offsets.push(offset)
    parts.push(object.bytes)
    offset += object.bytes.length
  }
  const xrefOffset = offset
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map(
      (value) => `${value.toString().padStart(10, '0')} 00000 n `,
    ),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ].join('\n')
  parts.push(latin1(xref))
  return concat(parts)
}


