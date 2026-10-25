/**
 * Small, forgiving XML reader used by KML and GPX importers.
 *
 * It deliberately ignores namespaces (matching on local names), accepts
 * unclosed trailing elements and bounds nesting so a hostile document cannot
 * exhaust the stack. Third-party files are untrusted input.
 */

import { tr } from './locale.ts'

export interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

const MAX_DEPTH = 96
const MAX_NODES = 200_000

const localName = (name: string): string => {
  const colon = name.lastIndexOf(':')
  return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase()
}

const decodeEntities = (raw: string): string => {
  if (!raw.includes('&')) return raw
  return raw.replace(
    /&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi,
    (match, entity: string) => {
      const lower = entity.toLowerCase()
      if (lower === 'lt') return '<'
      if (lower === 'gt') return '>'
      if (lower === 'amp') return '&'
      if (lower === 'quot') return '"'
      if (lower === 'apos') return "'"
      const code = lower.startsWith('#x')
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    },
  )
}

class Reader {
  pos = 0
  nodes = 0
  private readonly input: string

  constructor(input: string) {
    this.input = input
  }

  parse(): XmlNode {
    this.skipMisc()
    if (this.input[this.pos] !== '<') {
      throw new Error(tr('Документ не содержит корневого элемента', 'The document has no root element'))
    }
    const root = this.element(0)
    return root
  }

  private startsWith(prefix: string): boolean {
    return this.input.startsWith(prefix, this.pos)
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.input[this.pos] ?? '')) this.pos += 1
  }

  private skipUntil(marker: string): void {
    const index = this.input.indexOf(marker, this.pos)
    if (index < 0) throw new Error(tr('Незакрытая секция XML', 'Unclosed XML section'))
    this.pos = index + marker.length
  }

  private skipMisc(): void {
    for (;;) {
      this.skipWhitespace()
      if (this.startsWith('<?')) {
        this.pos += 2
        this.skipUntil('?>')
      } else if (this.startsWith('<!--')) {
        this.pos += 4
        this.skipUntil('-->')
      } else if (this.startsWith('<!')) {
        this.skipDeclaration()
      } else {
        return
      }
    }
  }

  private skipDeclaration(): void {
    this.pos += 2
    let depth = 0
    let quote = ''
    while (this.pos < this.input.length) {
      const char = this.input[this.pos]
      this.pos += 1
      if (quote) {
        if (char === quote) quote = ''
        continue
      }
      if (char === '"' || char === "'") quote = char
      else if (char === '[') depth += 1
      else if (char === ']') depth = Math.max(0, depth - 1)
      else if (char === '>' && depth === 0) return
    }
    throw new Error(tr('Незакрытое объявление XML', 'Unclosed XML declaration'))
  }

  private element(depth: number): XmlNode {
    if (depth > MAX_DEPTH) {
      throw new Error(tr(
                        'Вложенность XML больше {p0} уровней',
                        'XML nesting exceeds {p0} levels',
                        { p0: MAX_DEPTH },
                      ))
    }
    this.nodes += 1
    if (this.nodes > MAX_NODES) {
      throw new Error(tr(
                        'В XML больше {p0} элементов',
                        'XML has more than {p0} elements',
                        { p0: MAX_NODES },
                      ))
    }
    if (this.input[this.pos] !== '<') throw new Error(tr('Ожидался тег XML', 'An XML tag was expected'))
    this.pos += 1
    const { name, attrs, selfClosing } = this.startTag()
    const node: XmlNode = { name, attrs, children: [], text: '' }
    if (selfClosing) return node
    for (;;) {
      const start = this.pos
      const next = this.input.indexOf('<', this.pos)
      const end = next < 0 ? this.input.length : next
      if (end > start) node.text += decodeEntities(this.input.slice(start, end))
      this.pos = end
      if (this.pos >= this.input.length) break
      if (this.startsWith('<!--')) {
        this.pos += 4
        this.skipUntil('-->')
      } else if (this.startsWith('<![CDATA[')) {
        this.pos += 9
        const close = this.input.indexOf(']]>', this.pos)
        if (close < 0) throw new Error(tr('Незакрытая секция CDATA', 'Unclosed CDATA section'))
        node.text += this.input.slice(this.pos, close)
        this.pos = close + 3
      } else if (this.startsWith('<?')) {
        this.pos += 2
        this.skipUntil('?>')
      } else if (this.startsWith('<!')) {
        this.skipDeclaration()
      } else if (this.startsWith('</')) {
        this.pos += 2
        const closing = localName(this.readName())
        this.skipUntil('>')
        if (closing === node.name) break
        // Broken exporters sometimes leave stray closing tags; ignore them.
      } else {
        node.children.push(this.element(depth + 1))
      }
    }
    return node
  }

  private startTag(): {
    name: string
    attrs: Record<string, string>
    selfClosing: boolean
  } {
    const rawName = this.readName()
    if (!rawName) throw new Error(tr('Пустое имя элемента XML', 'Empty XML element name'))
    const name = localName(rawName)
    const attrs: Record<string, string> = {}
    for (;;) {
      this.skipWhitespace()
      const char = this.input[this.pos]
      if (char === '>') {
        this.pos += 1
        return { name, attrs, selfClosing: false }
      }
      if (char === '/') {
        this.pos += 1
        if (this.input[this.pos] !== '>') {
          throw new Error(tr('Некорректный самозакрывающийся тег', 'Invalid self-closing tag'))
        }
        this.pos += 1
        return { name, attrs, selfClosing: true }
      }
      if (this.pos >= this.input.length) {
        throw new Error(tr('Незакрытый тег XML', 'Unclosed XML tag'))
      }
      const attr = this.readName()
      if (!attr) {
        this.pos += 1
        continue
      }
      this.skipWhitespace()
      if (this.input[this.pos] !== '=') continue
      this.pos += 1
      this.skipWhitespace()
      const quote = this.input[this.pos]
      if (quote !== '"' && quote !== "'") {
        throw new Error(tr('Значение атрибута без кавычек', 'Unquoted attribute value'))
      }
      this.pos += 1
      const start = this.pos
      const close = this.input.indexOf(quote, start)
      if (close < 0) throw new Error(tr('Незакрытое значение атрибута', 'Unclosed attribute value'))
      attrs[localName(attr)] = decodeEntities(this.input.slice(start, close))
      this.pos = close + 1
    }
  }

  private readName(): string {
    const start = this.pos
    while (this.pos < this.input.length) {
      const char = this.input[this.pos]
      if (/\s|=|>|\/|</.test(char)) break
      this.pos += 1
    }
    return this.input.slice(start, this.pos)
  }
}

export function parseXml(input: string): XmlNode {
  return new Reader(input.replace(/^\uFEFF/, '')).parse()
}

export const child = (node: XmlNode, name: string): XmlNode | undefined =>
  node.children.find((item) => item.name === name)

export const childrenNamed = (node: XmlNode, name: string): XmlNode[] =>
  node.children.filter((item) => item.name === name)

export const nodeText = (node: XmlNode | undefined): string =>
  node ? node.text.trim() : ''

/** Finds direct children, following common KML folder wrappers. */
export function childText(node: XmlNode, name: string): string {
  return nodeText(child(node, name))
}

/** Depth-first search for a local element name. */
export function findDescendants(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = []
  const visit = (current: XmlNode) => {
    for (const item of current.children) {
      if (item.name === name) found.push(item)
      visit(item)
    }
  }
  visit(node)
  return found
}
