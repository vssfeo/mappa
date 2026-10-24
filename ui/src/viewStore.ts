/** High-frequency viewport state kept out of the persisted project store. */

import { create } from 'zustand'
import type { MapView } from './store'

interface StoredView {
  center: [number, number]
  zoom: number
}

const STORAGE_KEY = 'mappa-view'
const PERSIST_DELAY_MS = 500
const DEFAULT_VIEW: MapView = {
  center: [37.6173, 55.7558],
  zoom: 10,
  bounds: null,
  scale: 0,
}

const validPoint = (value: unknown): value is [number, number] =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((item) => typeof item === 'number' && Number.isFinite(item)) &&
  Math.abs(value[0]) <= 180 &&
  Math.abs(value[1]) <= 85.05112878

const loadView = (): MapView => {
  if (typeof window === 'undefined') return DEFAULT_VIEW
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_VIEW
    const parsed = JSON.parse(raw) as { center?: unknown; zoom?: unknown }
    if (
      !validPoint(parsed.center) ||
      typeof parsed.zoom !== 'number' ||
      !Number.isFinite(parsed.zoom) ||
      parsed.zoom < 0 ||
      parsed.zoom > 20
    ) {
      return DEFAULT_VIEW
    }
    return {
      center: parsed.center,
      zoom: parsed.zoom,
      bounds: null,
      scale: 0,
    }
  } catch {
    return DEFAULT_VIEW
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null

const flushView = () => {
  persistTimer = null
  if (typeof window === 'undefined') return
  try {
    const view = useViewStore.getState().mapView
    const stored: StoredView = { center: view.center, zoom: view.zoom }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  } catch (error) {
    console.warn('cannot persist map view', error)
  }
}

const schedulePersist = () => {
  if (persistTimer !== null) clearTimeout(persistTimer)
  persistTimer = setTimeout(flushView, PERSIST_DELAY_MS)
}

interface ViewStore {
  mapView: MapView
  cursor: [number, number] | null
  setMapView: (view: MapView) => void
  setCursor: (cursor: [number, number] | null) => void
}

export const useViewStore = create<ViewStore>((set) => ({
  mapView: loadView(),
  cursor: null,
  setMapView: (mapView) => {
    set({ mapView })
    schedulePersist()
  },
  setCursor: (cursor) => set({ cursor }),
}))

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushView)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushView()
  })
}
