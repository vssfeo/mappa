import { invoke } from '@tauri-apps/api/core'
import { isNative } from './native.ts'

export interface GeocodePlace {
  id: string
  name: string
  label: string
  lon: number
  lat: number
  kind?: string
  source: string
}

export interface GeocodeResponse {
  places: GeocodePlace[]
  online: boolean
  warning?: string
}

/**
 * Searches the local place cache and the online fallback.
 *
 * The browser build has no Rust side, so it reports a stable warning instead
 * of pretending that an empty result means “nothing found”.
 */
export async function geocodeSearch(
  query: string,
  lang: string,
  limit = 6,
): Promise<GeocodeResponse> {
  if (!isNative) {
    return { places: [], online: false, warning: 'native_only' }
  }
  return invoke<GeocodeResponse>('geocode_search', {
    query,
    lang,
    limit,
  })
}
