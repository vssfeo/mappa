import { invoke } from '@tauri-apps/api/core'

export interface TorrentInfo {
  name: string
  bytes: number
  pieceLength: number
  infoHash: string
  magnet: string
  torrent: string
}

export async function createPackTorrent(
  source: string,
  destination: string,
): Promise<TorrentInfo> {
  return invoke<TorrentInfo>('create_pack_torrent', { source, destination })
}

export async function openMagnet(magnet: string): Promise<void> {
  return invoke('open_magnet', { magnet })
}
