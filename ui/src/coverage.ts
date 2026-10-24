/** Cached-tile coverage overlay state. */

import { create } from 'zustand'
import { coverageTiles } from './native'
import { useViewStore } from './viewStore'
import { tr } from './locale.ts'

export type CoverageTile = [number, number, number]

interface CoverageStore {
  visible: boolean
  tiles: CoverageTile[]
  truncated: boolean
  busy: boolean
  error: string | null
  setVisible: (visible: boolean) => void
  refresh: (providerId: string) => Promise<void>
}

const clampZoom = (zoom: number) =>
  Math.max(0, Math.min(20, Math.round(zoom)))

export const useCoverageStore = create<CoverageStore>((set) => ({
  visible: false,
  tiles: [],
  truncated: false,
  busy: false,
  error: null,
  setVisible: (visible) =>
    set({ visible, tiles: [], truncated: false, error: null }),
  refresh: async (providerId) => {
    const view = useViewStore.getState().mapView
    if (!view.bounds) {
      set({
        error: tr('Карта ещё не готова', 'The map is not ready yet'),
        tiles: [],
        truncated: false,
      })
      return
    }
    const [[west, south], [east, north]] = view.bounds
    set({ busy: true, error: null })
    try {
      const result = await coverageTiles(
        providerId,
        clampZoom(view.zoom),
        west,
        south,
        east,
        north,
      )
      set({
        tiles: result.tiles,
        truncated: result.truncated,
        busy: false,
      })
    } catch (error) {
      set({ busy: false, error: String(error) })
    }
  },
}))
