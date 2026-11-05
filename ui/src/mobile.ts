import { invoke } from '@tauri-apps/api/core'

export interface MobileInfo {
  url: string
  qrSvg: string
  port: number
}

export async function startMobileServer(
  packs: string[],
  tls: boolean,
): Promise<MobileInfo> {
  return invoke<MobileInfo>('start_mobile_server', { packs, tls })
}

export async function stopMobileServer(): Promise<void> {
  return invoke('stop_mobile_server')
}
