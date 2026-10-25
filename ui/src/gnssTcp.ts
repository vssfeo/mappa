/** Native TCP transports for external GNSS streams: NMEA 0183 and gpsd. */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export type GnssStreamKind = 'nmea' | 'gpsd'
export type StreamStatus = 'connecting' | 'connected' | 'error'

export interface StreamState {
  status: StreamStatus
  host: string
  port: number
  message: string | null
}

export interface GnssEndpoint {
  host: string
  port: number
}

export const DEFAULT_NMEA_HOST = '127.0.0.1'
export const DEFAULT_NMEA_PORT = 10110
export const DEFAULT_GPSD_HOST = '127.0.0.1'
export const DEFAULT_GPSD_PORT = 2947

const ENDPOINT_KEYS: Record<GnssStreamKind, string> = {
  nmea: 'mappa-nmea-endpoint',
  gpsd: 'mappa-gpsd-endpoint',
}
const MAX_HOST = 253

const defaultEndpoint = (kind: GnssStreamKind): GnssEndpoint =>
  kind === 'nmea'
    ? { host: DEFAULT_NMEA_HOST, port: DEFAULT_NMEA_PORT }
    : { host: DEFAULT_GPSD_HOST, port: DEFAULT_GPSD_PORT }

export const isNativeGnss = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** Keeps the editable endpoint within the limits accepted by the backend. */
export function normalizeGnssEndpoint(
  host: string,
  port: number,
): GnssEndpoint {
  const trimmed = host.trim().slice(0, MAX_HOST)
  const fallback = Number.isFinite(port) ? port : DEFAULT_NMEA_PORT
  return {
    host: trimmed,
    port: Math.min(65_535, Math.max(1, Math.round(fallback))),
  }
}

export function loadGnssEndpoint(kind: GnssStreamKind): GnssEndpoint {
  const fallback = defaultEndpoint(kind)
  if (typeof localStorage === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(ENDPOINT_KEYS[kind])
    if (!raw) return fallback
    const value = JSON.parse(raw) as Partial<GnssEndpoint>
    if (typeof value.host !== 'string' || typeof value.port !== 'number') {
      return fallback
    }
    return normalizeGnssEndpoint(value.host, value.port)
  } catch {
    return fallback
  }
}

export function saveGnssEndpoint(
  kind: GnssStreamKind,
  host: string,
  port: number,
): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(
      ENDPOINT_KEYS[kind],
      JSON.stringify({ host, port }),
    )
  } catch {
    // Storage may be disabled; the endpoint still works for this session.
  }
}

/** Installs both event listeners; the returned function removes them. */
export async function listenGnssStream(
  kind: GnssStreamKind,
  onLine: (line: string) => void,
  onState: (state: StreamState) => void,
): Promise<() => void> {
  let unlistenLine: (() => void) | null = null
  try {
    unlistenLine = await listen<string>(`${kind}://line`, (event) => {
      if (typeof event.payload === 'string') onLine(event.payload)
    })
    const unlistenState = await listen<StreamState>(
      `${kind}://state`,
      (event) => {
        const state = event.payload
        if (
          state &&
          (state.status === 'connecting' ||
            state.status === 'connected' ||
            state.status === 'error')
        ) {
          onState(state)
        }
      },
    )
    return () => {
      unlistenLine?.()
      unlistenState()
    }
  } catch (error) {
    unlistenLine?.()
    throw error
  }
}

const command = (kind: GnssStreamKind, action: 'start' | 'stop'): string =>
  `${action}_${kind}_tcp`

export async function startGnssTcp(
  kind: GnssStreamKind,
  host: string,
  port: number,
): Promise<void> {
  if (!isNativeGnss()) {
    throw new Error('A TCP GNSS stream is available only in the desktop app')
  }
  await invoke(command(kind, 'start'), { host, port })
}

export async function stopGnssTcp(kind: GnssStreamKind): Promise<void> {
  if (!isNativeGnss()) return
  await invoke(command(kind, 'stop'))
}
