#!/usr/bin/env node
/**
 * Deep source scan for invisible or confusable characters.
 *
 * Catches zero-width and bidi controls, non-standard spaces, private-use
 * code points, lone surrogates, invalid UTF-8, non-NFC text and identifiers
 * that mix Latin with Cyrillic/Greek homoglyphs.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIRS = new Set([
  '.git',
  '.vite',
  'dist',
  'node_modules',
  'playwright-report',
  'target',
  'test-results',
])
const TEXT_EXTENSIONS = new Set([
  '',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.rs',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
])
const SKIP_FILES = new Set(['Cargo.lock', 'package-lock.json'])
const MAX_REPORTS_PER_FILE = 12

const invisible = new Map([
  [0x00ad, 'soft hyphen'],
  [0x034f, 'combining grapheme joiner'],
  [0x061c, 'arabic letter mark'],
  [0x115f, 'hangul choseong filler'],
  [0x1160, 'hangul jungseong filler'],
  [0x17b4, 'khmer inherent vowel aq'],
  [0x17b5, 'khmer inherent vowel aa'],
  [0x180b, 'mongolian free variation selector'],
  [0x180c, 'mongolian free variation selector'],
  [0x180d, 'mongolian free variation selector'],
  [0x180e, 'mongolian vowel separator'],
  [0x200b, 'zero-width space'],
  [0x200c, 'zero-width non-joiner'],
  [0x200d, 'zero-width joiner'],
  [0x200e, 'left-to-right mark'],
  [0x200f, 'right-to-left mark'],
  [0x202a, 'left-to-right embedding'],
  [0x202b, 'right-to-left embedding'],
  [0x202c, 'pop directional formatting'],
  [0x202d, 'left-to-right override'],
  [0x202e, 'right-to-left override'],
  [0x2060, 'word joiner'],
  [0x2061, 'function application'],
  [0x2062, 'invisible times'],
  [0x2063, 'invisible separator'],
  [0x2064, 'invisible plus'],
  [0x2066, 'left-to-right isolate'],
  [0x2067, 'right-to-left isolate'],
  [0x2068, 'first strong isolate'],
  [0x2069, 'pop directional isolate'],
  [0x3164, 'hangul filler'],
  [0xfeff, 'byte-order mark'],
  [0xffa0, 'halfwidth hangul filler'],
  [0xfff9, 'interlinear annotation anchor'],
  [0xfffa, 'interlinear annotation separator'],
  [0xfffb, 'interlinear annotation terminator'],
  [0x2800, 'braille blank'],
])

const unusualSpaces = new Map([
  [0x00a0, 'no-break space'],
  [0x1680, 'ogham space mark'],
  [0x2000, 'en quad'],
  [0x2001, 'em quad'],
  [0x2002, 'en space'],
  [0x2003, 'em space'],
  [0x2004, 'three-per-em space'],
  [0x2005, 'four-per-em space'],
  [0x2006, 'six-per-em space'],
  [0x2007, 'figure space'],
  [0x2008, 'punctuation space'],
  [0x2009, 'thin space'],
  [0x200a, 'hair space'],
  [0x202f, 'narrow no-break space'],
  [0x205f, 'medium mathematical space'],
  [0x3000, 'ideographic space'],
])

const control = (cp) =>
  cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)

function classify(cp) {
  // Tabs and line breaks are legitimate; everything else in Cc is not.
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return null
  if (control(cp)) return 'control character'
  if (invisible.has(cp)) return invisible.get(cp)
  if (unusualSpaces.has(cp)) return unusualSpaces.get(cp)
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 'variation selector'
  if (cp >= 0xe0100 && cp <= 0xe01ef) return 'variation selector supplement'
  if (cp >= 0xe0000 && cp <= 0xe007f) return 'unicode tag character'
  if (cp === 0x2028 || cp === 0x2029) return 'line/paragraph separator'
  if ((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe) {
    return 'noncharacter'
  }
  if (cp >= 0xff01 && cp <= 0xff5e) return 'fullwidth ASCII variant'
  if (cp >= 0x1d400 && cp <= 0x1d7ff) {
    return 'mathematical alphanumeric symbol'
  }
  if (cp > 0x7f) {
    const character = String.fromCodePoint(cp)
    if (/\p{Cf}/u.test(character)) return 'format character'
    if (/\p{Co}/u.test(character)) return 'private-use character'
  }
  return null
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walk(join(directory, entry.name), files)
      }
      continue
    }
    if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue
    const extension = extname(entry.name).toLowerCase()
    if (!TEXT_EXTENSIONS.has(extension)) continue
    files.push(join(directory, entry.name))
  }
  return files
}

const homoglyphToken = /[A-Za-z0-9_$Ͱ-ϿЀ-ӿ]+/gu
const compassToken = /^[NSEWnsewСЮВЗсювз]+$/u
const utmBandToken = /^[C-HJ-NP-Xc-hj-np-xСЮсю]+$/u
const has = (value, pattern) => pattern.test(value)
const LATIN = /[A-Za-z]/
const CONFUSABLE = /[Ͱ-ϿЀ-ӿ]/

const findings = []
const warnings = []
const report = (bucket, file, line, column, message) =>
  bucket.push({ file, line, column, message })

for (const path of walk(ROOT)) {
  const buffer = readFileSync(path)
  if (buffer.subarray(0, 8192).includes(0)) continue // binary

  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    report(findings, relative(ROOT, path), 1, 1, 'invalid UTF-8')
    continue
  }

  if (text.includes('\uFFFD')) {
    report(findings, relative(ROOT, path), 1, 1, 'replacement character')
  }
  if (text.normalize('NFC') !== text) {
    report(warnings, relative(ROOT, path), 1, 1, 'text is not NFC-normalised')
  }

  let line = 1
  let column = 1
  let lineFindings = 0
  for (let index = 0; index < text.length; ) {
    const cp = text.codePointAt(index)
    const width = cp > 0xffff ? 2 : 1
    const message = classify(cp)
    if (message) {
      lineFindings += 1
      if (lineFindings <= MAX_REPORTS_PER_FILE) {
        const code = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
        report(
          findings,
          relative(ROOT, path),
          line,
          column,
          `${message} (${code})`,
        )
      }
    }
    if (cp === 0x0a) {
      line += 1
      column = 1
    } else {
      column += width
    }
    index += width
  }

  for (const [index, source] of text.split('\n').entries()) {
    for (const match of source.matchAll(homoglyphToken)) {
      const token = match[0]
      // `\nзадача` is a Rust escape followed by text, not an identifier.
      if (source[match.index - 1] === '\\') continue
      // Bilingual compass/UTM-band abbreviations are data, not identifiers.
      if (compassToken.test(token) || utmBandToken.test(token)) continue
      if (has(token, LATIN) && has(token, CONFUSABLE)) {
        report(
          findings,
          relative(ROOT, path),
          index + 1,
          match.index + 1,
          `mixed Latin and non-Latin letters in ${JSON.stringify(token)}`,
        )
      }
    }
  }
}

const print = (bucket, label) => {
  for (const item of bucket) {
    console.error(
      `${item.file}:${item.line}:${item.column}: ${label}: ${item.message}`,
    )
  }
}

print(findings, 'hidden')
print(warnings, 'warning')

if (findings.length > 0) {
  console.error(`\n${findings.length} hidden-character finding(s)`)
  process.exit(1)
}
if (warnings.length > 0) {
  console.error(`\n${warnings.length} warning(s), no hidden characters`)
}
console.log(
  `Unicode scan OK: ${findings.length} errors, ${warnings.length} warnings`,
)
