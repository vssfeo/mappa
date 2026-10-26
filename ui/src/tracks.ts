/** GPX tracks uploaded by the mobile companion. */

import { invoke } from '@tauri-apps/api/core'
import { isNative } from './native'

export interface TrackFile {
  name: string
  path: string
  size: number
  modified: number
}

const KEY = 'mappa-imported-tracks'

/** Paths already imported into a project, persisted across restarts. */
export const importedTracks = (): Set<string> => {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(KEY) ?? '[]'))
  } catch {
    return new Set<string>()
  }
}

export const markTrackImported = (path: string): void => {
  const imported = importedTracks()
  imported.add(path)
  localStorage.setItem(KEY, JSON.stringify([...imported].slice(-500)))
}

export const forgetTrack = (path: string): void => {
  const imported = importedTracks()
  imported.delete(path)
  localStorage.setItem(KEY, JSON.stringify([...imported].slice(-500)))
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

/** Path of the inbox shown in the UI. */
export const tracksFolder = async (): Promise<string> => {
  if (!isNative) return ''
  try {
    return await invoke<string>('tracks_folder')
  } catch {
    return ''
  }
}

/** Deletes a GPX file from the inbox. */
export const deleteTrack = async (path: string): Promise<void> => {
  if (!isNative) return
  await invoke('delete_track', { path })
}
