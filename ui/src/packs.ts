import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { isNative } from './native'
import { serialize } from './serial'
import { useAppStore, type PackLayer } from './store'
import { tr } from './locale.ts'

interface PackInfo {
  id: string
  name: string
  path: string
  kind: 'mbtiles' | 'pmtiles'
  format: string
  vectorLayers: string[]
  minZoom: number
  maxZoom: number
  west: number
  south: number
  east: number
  north: number
  attribution: string | null
  tiles: number | null
}

const toLayer = (info: PackInfo): PackLayer => ({
  ...info,
  visible: true,
  opacity: 1,
})

/** Opens a pack by absolute path and registers it as a map layer. */
export const openPackPath = async (path: string): Promise<PackLayer> => {
  if (!isNative) {
    throw new Error(tr('Импорт паков доступен в нативном приложении', 'Pack import is available in the native app'))
  }
  const info = await invoke<PackInfo>('open_pack', { path })
  const layer = toLayer(info)
  useAppStore.getState().addPack(layer)
  return layer
}

export const importPack = async (): Promise<PackLayer | null> => {
  if (!isNative) {
    throw new Error(tr('Импорт паков доступен в нативном приложении', 'Pack import is available in the native app'))
  }
  const selected = await open({
    multiple: false,
    directory: false,
    title: tr('Открыть офлайн-пак', 'Open an offline pack'),
    filters: [
      { name: tr('Карты Mappa', 'Mappa maps'), extensions: ['mbtiles', 'pmtiles'] },
    ],
  })
  const path = Array.isArray(selected) ? selected[0] : selected
  if (typeof path !== 'string' || path.length === 0) return null
  return openPackPath(path)
}

export const closePack = async (id: string): Promise<void> => {
  try {
    if (isNative) await invoke('close_pack', { id })
  } finally {
    useAppStore.getState().removePack(id)
  }
}

let restoring: Promise<void> | null = null

/** Reopens packs remembered from the previous session. */
export const restorePacks = (): Promise<void> => {
  if (!isNative) return Promise.resolve()
  restoring ??= serialize(async () => {
    const paths = [...useAppStore.getState().packPaths]
    await Promise.all(
      paths.map(async (path) => {
        try {
          await openPackPath(path)
        } catch (error) {
          console.warn('cannot restore pack', path, error)
          useAppStore.getState().forgetPackPath(path)
        }
      }),
    )
  })
  return restoring
}
