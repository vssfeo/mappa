/** GPX tracks uploaded by the mobile companion. */

import { invoke } from '@tauri-apps/api/core'
import { isNative } from './native'

export interface TrackFile {
  name: string
  path: string
  size: number
  modified: number
}

/** Lists GPX files in the app cache `tracks/` directory. */
export const listTracks = async (): Promise<TrackFile[]> => {
  if (!isNative) return []
  try {
    return await invoke<TrackFile[]>('list_tracks')
  } catch {
    return []
  }
}
