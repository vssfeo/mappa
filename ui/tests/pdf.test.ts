import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPdf } from '../src/pdf.ts'

test('builds a structurally valid one-page PDF', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
  const pdf = buildPdf(jpeg, 120, 80)
  const text = new TextDecoder('latin1').decode(pdf)
  assert.ok(text.startsWith('%PDF-1.4\n'))
  assert.match(text, /\/Width 120/)
  assert.match(text, /\/Height 80/)
  assert.match(text, /\/MediaBox \[0 0 842 595\]/)
  assert.equal((text.match(/\d+ 0 obj/g) ?? []).length, 6)
  assert.match(text, /\/Font << \/F1 6 0 R >>/)
  assert.match(text, /Mappa map/)
  assert.ok(text.includes(' re S'))
  const start = Number(text.match(/startxref\n(\d+)/)?.[1])
  assert.ok(Number.isInteger(start) && start > 0)
  assert.equal(text.slice(start, start + 4), 'xref')
  assert.ok(text.endsWith('%%EOF\n'))
})

test('switches to portrait for tall images', () => {
  const pdf = buildPdf(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 80, 120)
  assert.match(new TextDecoder('latin1').decode(pdf), /\/MediaBox \[0 0 595 842\]/)
})
