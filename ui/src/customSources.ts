/** User-defined XYZ/TMS/WMS sources stored by the native backend. */

import { invoke } from '@tauri-apps/api/core'
import { isNative } from './native'
import { tr } from './locale.ts'

export type CustomSourceKind = 'xyz' | 'wms' | 'wmts'

export interface CustomSource {
  id: string
  name: string
  kind: CustomSourceKind
  url: string
  scheme: 'xyz' | 'tms'
  minZoom: number
  maxZoom: number
  tileSize: number
  format: string
  attribution: string
  terms: string | null
  headers: Record<string, string>
  rps: number
  burst: number
  offlineAllowed: boolean
}

export interface CustomSourceDraft {
  id?: string
  name: string
  kind: CustomSourceKind
  url: string
  scheme: 'xyz' | 'tms'
  minZoom: number
  maxZoom: number
  tileSize: number
  format: string
  attribution: string
  headers: Record<string, string>
  rps: number
  burst: number
  offlineAllowed: boolean
}

export function newSourceId(): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replaceAll('-', '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12)
  return `custom-${suffix}`
}

export async function listCustomSources(): Promise<CustomSource[]> {
  if (!isNative) return []
  try {
    return await invoke<CustomSource[]>('list_custom_sources')
  } catch (error) {
    console.warn('list_custom_sources failed', error)
    return []
  }
}

export async function saveCustomSource(
  draft: CustomSourceDraft,
): Promise<CustomSource> {
  if (!isNative) {
    throw new Error(tr('Свои источники доступны в нативном приложении', 'Custom sources are available in the native app'))
  }
  return invoke<CustomSource>('save_custom_source', {
    source: {
      id: draft.id ?? newSourceId(),
      name: draft.name.trim(),
      kind: draft.kind,
      url: draft.url.trim(),
      scheme: draft.scheme,
      minZoom: draft.minZoom,
      maxZoom: draft.maxZoom,
      tileSize: draft.tileSize,
      format: draft.format,
      attribution: draft.attribution.trim(),
      terms: null,
      headers: draft.headers,
      rps: draft.rps,
      burst: draft.burst,
      offlineAllowed: draft.offlineAllowed,
    },
  })
}

export async function deleteCustomSource(id: string): Promise<void> {
  if (!isNative) return
  await invoke('delete_custom_source', { id })
}

/** Serializes request headers back into the editable text form. */
export function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

/** Parses `Name: value` lines into request headers. */
export function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf(':')
    if (index <= 0) continue
    const name = trimmed.slice(0, index).trim()
    const value = trimmed.slice(index + 1).trim()
    if (name && value) headers[name] = value
  }
  return headers
}
