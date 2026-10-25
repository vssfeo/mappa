/** MAVLink telemetry: receive-only UDP listener. */

import { invoke } from '@tauri-apps/api/core'
import { isNative } from './native'

export interface TelemetryFix {
  lat: number
  lon: number
  altM: number
  headingDeg: number
  atMs: number
}

export interface TelemetryStatus {
  running: boolean
  port: number
  frames: number
  trackPoints: number
  fix: TelemetryFix | null
  lastHeartbeatMs: number | null
}

export const startMavlink = async (port: number): Promise<void> => {
  if (!isNative) throw new Error('telemetry is available in the desktop app')
  await invoke('start_mavlink', { port })
}

export const stopMavlink = async (): Promise<void> => {
  if (!isNative) return
  await invoke('stop_mavlink')
}

export const mavlinkStatus = async (): Promise<TelemetryStatus | null> => {
  if (!isNative) return null
  try {
    return await invoke<TelemetryStatus>('mavlink_status')
  } catch {
    return null
  }
}

export const mavlinkTrack = async (): Promise<TelemetryFix[]> => {
  if (!isNative) return []
  try {
    return await invoke<TelemetryFix[]>('mavlink_track')
  } catch {
    return []
  }
}

export const mavlinkClear = async (): Promise<void> => {
  if (!isNative) return
  await invoke('mavlink_clear')
}

/** GPX 1.1 track from telemetry points. */
export const telemetryGpx = (points: TelemetryFix[], name = 'MAVLink'): string => {
  const track = points
    .map(
      (point) =>
        `      <trkpt lat="${point.lat.toFixed(7)}" lon="${point.lon.toFixed(7)}">` +
        `<ele>${point.altM.toFixed(1)}</ele>` +
        `<time>${new Date(point.atMs).toISOString()}</time>` +
        `</trkpt>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Mappa" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name}</name>
    <trkseg>
${track}
    </trkseg>
  </trk>
</gpx>
`
}
