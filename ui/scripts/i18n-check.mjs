#!/usr/bin/env node
/**
 * Verifies that every static English source string passed to tx/tr/
 * translateText exists in all additional catalogs. Interpolated `${...}`
 * templates are reported so they can be converted to `{name}` placeholders.
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import { CATALOGS, LOCALES } from '../src/locales/index.ts'

const root = path.resolve(import.meta.dirname, '..', 'src')
const files = []
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full)
  }
}
walk(root)

const english = new Map()
const dynamic = []
const callNames = new Set(['tx', 'tr', 'translateText'])
const englishIndex = { tx: 1, tr: 1, translateText: 2 }

const visit = (node, source) => {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const name = node.expression.text
    if (callNames.has(name)) {
      const argument = node.arguments[englishIndex[name]]
      if (argument) {
        if (
          ts.isStringLiteral(argument) ||
          ts.isNoSubstitutionTemplateLiteral(argument)
        ) {
          english.set(argument.text, source.fileName)
        } else if (ts.isTemplateExpression(argument)) {
          const { line } = source.getLineAndCharacterOfPosition(
            argument.getStart(source),
          )
          dynamic.push(
            `${path.relative(root, source.fileName)}:${line + 1} ${argument.getText(source).slice(0, 100)}`,
          )
        }
      }
    }
  }
  ts.forEachChild(node, (child) => visit(child, source))
}

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  visit(source, source)
}

// The en table in i18n.ts is another source of English labels for t(key).
const i18nText = fs.readFileSync(path.join(root, 'i18n.ts'), 'utf8')
const i18nSource = ts.createSourceFile(
  'i18n.ts',
  i18nText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
)
for (const statement of i18nSource.statements) {
  if (!ts.isVariableStatement(statement)) continue
  for (const declaration of statement.declarationList.declarations) {
    if (declaration.name.getText(i18nSource) !== 'en') continue
    let initializer = declaration.initializer
    if (initializer && ts.isAsExpression(initializer)) {
      initializer = initializer.expression
    }
    if (!initializer || !ts.isObjectLiteralExpression(initializer)) continue
    for (const property of initializer.properties) {
      if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)) {
        english.set(property.initializer.text, 'i18n.ts:en')
      }
    }
  }
}

let failed = false
if (dynamic.length > 0) {
  console.error(`interpolated translations (${dynamic.length}):`)
  for (const entry of dynamic) console.error(`  ${entry}`)
  failed = true
}

for (const locale of LOCALES) {
  if (locale === 'ru' || locale === 'en') continue
  const catalog = CATALOGS[locale]
  const missing = [...english.keys()].filter((key) => !(key in catalog))
  if (missing.length > 0) {
    console.error(`${locale}: ${missing.length} missing keys`)
    for (const key of missing) {
      console.error(`  ${JSON.stringify(key)}  (${english.get(key)})`)
    }
    failed = true
  }
}

const unused = Object.keys(CATALOGS.de).filter((key) => !english.has(key))
if (unused.length > 0) {
  console.warn(`warning: ${unused.length} catalog keys are not used in src`)
  for (const key of unused.slice(0, 20)) console.warn(`  ${JSON.stringify(key)}`)
}

if (failed) process.exit(1)
console.log(`i18n: ${english.size} English strings in ${LOCALES.length - 2} catalogs`)
