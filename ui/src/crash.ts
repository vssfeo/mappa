/** Local crash reports: opt-in, never sent automatically. */

import { invoke } from '@tauri-apps/api/core'
import { isNative } from './native'

export interface CrashReport {
  id: string
  at: string
  kind: 'panic' | 'javascript' | string
  message: string
  version: string
  os: string
  location: string
  stack: string
}

export const listCrashes = async (): Promise<CrashReport[]> => {
  if (!isNative) return []
  try {
    return await invoke<CrashReport[]>('crash_list')
  } catch {
    return []
  }
}

export const readCrash = (id: string): Promise<string> =>
  invoke<string>('crash_read', { id })

export const deleteCrash = (id: string): Promise<void> =>
  invoke<void>('crash_delete', { id })

/** Only records; the Rust side ignores it unless the user enabled reports. */
export const reportJsError = (message: string, stack: string) => {
  if (!isNative) return
  void invoke('crash_report_js', { message, stack }).catch(() => {})
}
