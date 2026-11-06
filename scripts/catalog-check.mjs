#!/usr/bin/env node
// Validates catalog/catalog.json without external dependencies.
import { readFileSync } from 'node:fs'
import { CatalogError, validateCatalog } from './catalog-lib.mjs'

try {
  const path = new URL('../catalog/catalog.json', import.meta.url)
  const data = JSON.parse(readFileSync(path, 'utf8'))
  validateCatalog(data)
  console.log(`catalog: ${data.packs.length} packs OK`)
} catch (error) {
  console.error(`catalog: ${error instanceof CatalogError ? error.message : error}`)
  process.exit(1)
}
