#!/usr/bin/env node
// Appends the entry from a catalog issue to catalog/catalog.json.
import { readFileSync, writeFileSync } from 'node:fs'
import { CatalogError, entryFromIssue, validateCatalog } from './catalog-lib.mjs'

try {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  if (!event.issue) throw new CatalogError('no issue in the event')
  const entry = entryFromIssue(event.issue.body)
  const path = new URL('../catalog/catalog.json', import.meta.url)
  const catalog = JSON.parse(readFileSync(path, 'utf8'))
  if (catalog.packs.some((pack) => pack.id === entry.id)) {
    throw new CatalogError(`id "${entry.id}" already exists`)
  }
  catalog.packs.push(entry)
  catalog.updatedAt = new Date().toISOString()
  validateCatalog(catalog)
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`)
  console.log(`catalog: appended ${entry.id}`)
} catch (error) {
  console.error(`catalog-issue: ${error instanceof CatalogError ? error.message : error}`)
  process.exit(1)
}
