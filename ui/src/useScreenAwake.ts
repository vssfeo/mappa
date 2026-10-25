/** Keeps the screen awake in field mode when the user allows it. */

import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isNative } from './native'

type WakeLockSentinel = {
  release: () => Promise<void>
  addEventListener: (type: 'release', listener: () => void) => void
}

type WakeLockNavigator = Navigator & {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinel>
  }
}

/**
 * Native Linux uses `systemd-inhibit`; WebViews that expose the Screen Wake
 * Lock API fall back to it. Errors are deliberately silent: a missing
 * inhibitor must not break field navigation.
 */
export function useScreenAwake(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    let active = true
    let sentinel: WakeLockSentinel | null = null
    let native = false

    const acquire = async () => {
      if (!active || document.visibilityState !== 'visible') return
      if (isNative) {
        try {
          await invoke('set_screen_awake', { awake: true })
          native = true
          return
        } catch {
          native = false
        }
      }
      const wakeLock = (navigator as WakeLockNavigator).wakeLock
      if (!wakeLock) return
      try {
        sentinel = await wakeLock.request('screen')
        sentinel.addEventListener('release', () => {
          sentinel = null
        })
      } catch {
        sentinel = null
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire()
      else {
        void sentinel?.release()
        sentinel = null
      }
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      active = false
      document.removeEventListener('visibilitychange', onVisibility)
      void sentinel?.release()
      sentinel = null
      if (native) void invoke('set_screen_awake', { awake: false }).catch(() => {})
    }
  }, [enabled])
}
