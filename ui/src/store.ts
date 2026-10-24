import { create } from 'zustand'
import type { Geometry } from 'geojson'
import type { CustomSource } from './customSources'
import type { Bounds } from './format'
import type { CrsSpec } from './native'
import {
  FEATURE_COLORS,
  MAX_FEATURES,
  MAX_VERTICES,
  featureId,
  normalizeDraft,
  type FeatureMode,
  type MapFeature,
} from './features.ts'
import { circlePolygon, type LonLat } from './geo.ts'
import { setActiveLocale, tr, type Locale } from './locale.ts'
import type { CoordinateFormat, MapMarker } from './markers'
import { PROVIDERS, type ProviderId } from './providers.ts'
import type { VectorLayer, VectorStyle } from './vectorLayers.ts'
import {
  deleteGeometryVertex,
  insertGeometryVertex,
  moveGeometryVertex,
  type VertexPath,
} from './geometryEdit.ts'

/** Moves an item by `delta`; a positive delta raises it in the stack. */
const moveLayerItem = <T extends { id: string }>(
  items: T[],
  id: string,
  delta: number,
): T[] => {
  const index = items.findIndex((item) => item.id === id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= items.length) return items
  const next = [...items]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item)
  return next
}

/** Reorders items only when `ids` is an exact permutation of the current ids. */
const reorderLayerItems = <T extends { id: string }>(
  items: T[],
  ids: string[],
): T[] => {
  if (ids.length !== items.length) return items
  const byId = new Map(items.map((item) => [item.id, item]))
  const seen = new Set<string>()
  const next: T[] = []
  for (const id of ids) {
    const item = byId.get(id)
    if (!item || seen.has(id)) return items
    seen.add(id)
    next.push(item)
  }
  return next
}

const reorderPackPaths = (
  paths: string[],
  packs: { path: string }[],
): string[] => {
  const order = new Map(packs.map((pack, index) => [pack.path, index]))
  return [...paths].sort(
    (left, right) =>
      (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right) ?? Number.MAX_SAFE_INTEGER),
  )
}

export type Theme = 'dark' | 'light'
export type Panel =
  | 'layers'
  | 'downloads'
  | 'markers'
  | 'features'
  | 'projects'
  | 'settings'
  | null

export type MeasureMode = 'line' | 'area' | null

export interface RecentProject {
  name: string
  path: string
  at: number
}

export interface MapView {
  center: [number, number]
  zoom: number
  bounds: [[number, number], [number, number]] | null
  scale: number
}

export type LayerState = Record<ProviderId, { visible: boolean; opacity: number }>

export interface PackLayer {
  id: string
  name: string
  path: string
  kind: 'mbtiles' | 'pmtiles'
  format: string
  minZoom: number
  maxZoom: number
  west: number
  south: number
  east: number
  north: number
  attribution: string | null
  tiles: number | null
  visible: boolean
  opacity: number
}

export interface SelectedVector {
  layerId: string
  featureIndex: number
}

interface HistoryEntry {
  markers: MapMarker[]
  features: MapFeature[]
  vectorLayers: VectorLayer[]
}

interface AppState {
  history: HistoryEntry[]
  future: HistoryEntry[]
  undo: () => void
  redo: () => void
  clearHistory: () => void

  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  locale: Locale
  setLocale: (locale: Locale) => void

  providerId: ProviderId
  setProviderId: (id: ProviderId) => void

  panel: Panel
  setPanel: (panel: Panel) => void
  togglePanel: (panel: Exclude<Panel, null>) => void

  layers: LayerState
  toggleLayer: (id: ProviderId) => void
  setLayerOpacity: (id: ProviderId, opacity: number) => void

  customSources: CustomSource[]
  customLayers: Record<string, { visible: boolean; opacity: number }>
  setCustomSources: (sources: CustomSource[]) => void
  toggleCustomLayer: (id: string) => void
  setCustomLayerOpacity: (id: string, opacity: number) => void

  vectorLayers: VectorLayer[]
  addVectorLayer: (layer: VectorLayer) => void
  removeVectorLayer: (id: string) => void
  moveVectorLayer: (id: string, delta: number) => void
  reorderVectorLayers: (ids: string[]) => void
  toggleVectorLayer: (id: string) => void
  setVectorLayerOpacity: (id: string, opacity: number) => void
  setVectorLayerStyle: (id: string, patch: Partial<VectorStyle>) => void
  selectedVector: SelectedVector | null
  selectVectorFeature: (selection: SelectedVector | null) => void
  moveVectorVertex: (
    layerId: string,
    featureIndex: number,
    path: VertexPath,
    point: [number, number],
  ) => void
  insertVectorVertex: (
    layerId: string,
    featureIndex: number,
    path: VertexPath,
    point: [number, number],
  ) => void
  deleteVectorVertex: (
    layerId: string,
    featureIndex: number,
    path: VertexPath,
  ) => void

  packs: PackLayer[]
  packPaths: string[]
  addPack: (pack: PackLayer) => void
  removePack: (id: string) => void
  movePack: (id: string, delta: number) => void
  reorderPacks: (ids: string[]) => void
  forgetPackPath: (path: string) => void
  togglePack: (id: string) => void
  setPackOpacity: (id: string, opacity: number) => void

  selection: Bounds | null
  selectionPolygon: LonLat[] | null
  setSelection: (selection: Bounds | null) => void
  setSelectionPolygon: (points: LonLat[] | null) => void
  drawing: boolean
  setDrawing: (drawing: boolean) => void

  measureMode: MeasureMode
  measurePoints: LonLat[]
  setMeasureMode: (mode: MeasureMode) => void
  addMeasurePoint: (point: LonLat) => void
  undoMeasurePoint: () => void
  clearMeasure: () => void

  features: MapFeature[]
  featureMode: FeatureMode
  draftPoints: LonLat[]
  selectedFeatureId: string | null
  featureColor: string
  setFeatureMode: (mode: FeatureMode) => void
  setFeatureColor: (color: string) => void
  addDraftPoint: (point: LonLat) => void
  undoDraftPoint: () => void
  finishDraft: () => void
  cancelDraft: () => void
  selectFeature: (id: string | null) => void
  updateFeature: (id: string, patch: Partial<MapFeature>) => void
  moveFeatureVertex: (id: string, index: number, point: LonLat) => void
  deleteFeatureVertex: (id: string, index: number) => void
  appendFeatureVertex: (id: string) => void
  removeFeature: (id: string) => void
  addFeatures: (features: MapFeature[]) => void
  clearFeatures: () => void

  crs: CrsSpec | null
  crsLabel: string
  setCrs: (crs: CrsSpec | null, label: string) => void

  projectName: string
  projectPath: string | null
  recentProjects: RecentProject[]
  setProjectMeta: (name: string, path: string | null) => void
  addRecentProject: (project: RecentProject) => void
  clearRecentProjects: () => void

  markers: MapMarker[]
  placingMarker: boolean
  selectedMarkerId: string | null
  coordinateFormat: CoordinateFormat
  setPlacingMarker: (placing: boolean) => void
  setSelectedMarker: (id: string | null) => void
  addMarker: (marker: MapMarker) => void
  addMarkers: (markers: MapMarker[]) => void
  updateMarker: (id: string, patch: Partial<MapMarker>) => void
  removeMarker: (id: string) => void
  clearMarkers: () => void
  setCoordinateFormat: (format: CoordinateFormat) => void

  commandOpen: boolean
  setCommandOpen: (open: boolean) => void

  shortcutsOpen: boolean
  setShortcutsOpen: (open: boolean) => void

  downloadOpen: boolean
  setDownloadOpen: (open: boolean) => void

  fieldMode: boolean
  toggleFieldMode: () => void

  snapping: boolean
  toggleSnapping: () => void
  mapGrid: boolean
  toggleMapGrid: () => void

  packLicense: string
  setPackLicense: (license: string) => void

  autosaveEnabled: boolean
  setAutosaveEnabled: (enabled: boolean) => void

  toast: { id: number; message: string } | null
  showToast: (message: string) => void
  clearToast: () => void
}

const STORAGE_KEY = 'mappa-ui'
const PERSIST_DELAY_MS = 250
const PERSISTED_KEYS = [
  'theme',
  'locale',
  'providerId',
  'packPaths',
  'markers',
  'features',
  'featureColor',
  'customLayers',
  'coordinateFormat',
  'crs',
  'crsLabel',
  'projectName',
  'projectPath',
  'recentProjects',
  'snapping',
  'mapGrid',
  'packLicense',
  'autosaveEnabled',
] as const

/**
 * Serialisation is the expensive half of persistence: with tens of thousands
 * of markers, stringifying the whole workspace on every keystroke stalls the
 * UI. Defer both the snapshot and the write by a short settling window.
 */
const persistedSlice = (state: AppState) => ({
  theme: state.theme,
  locale: state.locale,
  providerId: state.providerId,
  packPaths: state.packPaths,
  markers: state.markers,
  features: state.features,
  featureColor: state.featureColor,
  customLayers: state.customLayers,
  coordinateFormat: state.coordinateFormat,
  crs: state.crs,
  crsLabel: state.crsLabel,
  projectName: state.projectName,
  projectPath: state.projectPath,
  packLicense: state.packLicense,
  mapGrid: state.mapGrid,
  autosaveEnabled: state.autosaveEnabled,
})

let persistTimer: ReturnType<typeof setTimeout> | null = null

const flushPersisted = () => {
  persistTimer = null
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: persistedSlice(useAppStore.getState()),
        version: 0,
      }),
    )
  } catch (error) {
    console.warn('cannot persist workspace', error)
  }
}

const schedulePersist = () => {
  if (persistTimer !== null) clearTimeout(persistTimer)
  persistTimer = setTimeout(flushPersisted, PERSIST_DELAY_MS)
}

let lastHistory = { key: '', at: 0 }

const historySnapshot = (state: AppState): HistoryEntry => ({
  markers: state.markers,
  features: state.features,
  vectorLayers: state.vectorLayers,
})

/**
 * Records the workspace before a mutation. Repeated edits of the same object
 * within 700 ms (typing a name, dragging a vertex) collapse into one step.
 */
const recordHistory = (
  state: AppState,
  key: string,
): { history: HistoryEntry[]; future: HistoryEntry[] } => {
  const now = Date.now()
  if (key === lastHistory.key && now - lastHistory.at < 700) {
    lastHistory.at = now
    return { history: state.history, future: [] }
  }
  lastHistory = { key, at: now }
  return {
    history: [...state.history, historySnapshot(state)].slice(-60),
    future: [],
  }
}

const layersFor = (
  providerId: ProviderId,
  previous?: LayerState,
): LayerState =>
  Object.fromEntries(
    PROVIDERS.map((provider) => [
      provider.id,
      {
        visible: provider.id === providerId,
        opacity: previous?.[provider.id]?.opacity ?? 1,
      },
    ]),
  ) as LayerState

const initialLayers = (): LayerState => layersFor('osm')

/** Immutably replaces one imported feature's geometry. */
const replaceVectorGeometry = (
  layers: VectorLayer[],
  layerId: string,
  featureIndex: number,
  geometry: Geometry,
): VectorLayer[] => {
  const layer = layers.find((item) => item.id === layerId)
  const feature = layer?.features[featureIndex]
  if (!layer || !feature) return layers
  const features = layer.features.slice()
  features[featureIndex] = { ...feature, geometry }
  return layers.map((item) =>
    item.id === layerId ? { ...item, features } : item,
  )
}

export const useAppStore = create<AppState>()(
  (set) => ({
    history: [],
    future: [],
    undo: () =>
      set((state) => {
        const entry = state.history[state.history.length - 1]
        if (!entry) return {}
        lastHistory = { key: '', at: 0 }
        return {
          history: state.history.slice(0, -1),
          future: [...state.future, historySnapshot(state)].slice(-60),
          markers: entry.markers,
          features: entry.features,
          vectorLayers: entry.vectorLayers,
          selectedMarkerId: entry.markers.some(
            (marker) => marker.id === state.selectedMarkerId,
          )
            ? state.selectedMarkerId
            : null,
          selectedFeatureId: entry.features.some(
            (feature) => feature.id === state.selectedFeatureId,
          )
            ? state.selectedFeatureId
            : null,
          selectedVector: entry.vectorLayers.some(
            (layer) =>
              layer.id === state.selectedVector?.layerId &&
              (state.selectedVector?.featureIndex ?? 0) < layer.features.length,
          )
            ? state.selectedVector
            : null,
          draftPoints: [],
          featureMode: 'off' as const,
        }
      }),
    redo: () =>
      set((state) => {
        const entry = state.future[state.future.length - 1]
        if (!entry) return {}
        lastHistory = { key: '', at: 0 }
        return {
          future: state.future.slice(0, -1),
          history: [...state.history, historySnapshot(state)].slice(-60),
          markers: entry.markers,
          features: entry.features,
          vectorLayers: entry.vectorLayers,
          selectedMarkerId: entry.markers.some(
            (marker) => marker.id === state.selectedMarkerId,
          )
            ? state.selectedMarkerId
            : null,
          selectedFeatureId: entry.features.some(
            (feature) => feature.id === state.selectedFeatureId,
          )
            ? state.selectedFeatureId
            : null,
          selectedVector: entry.vectorLayers.some(
            (layer) =>
              layer.id === state.selectedVector?.layerId &&
              (state.selectedVector?.featureIndex ?? 0) < layer.features.length,
          )
            ? state.selectedVector
            : null,
          draftPoints: [],
          featureMode: 'off' as const,
        }
      }),
    clearHistory: () => {
      lastHistory = { key: '', at: 0 }
      set({ history: [], future: [] })
    },

    theme: 'dark',
    setTheme: (theme) => set({ theme }),
    toggleTheme: () =>
      set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
    locale: 'ru',
    setLocale: (locale) => {
      setActiveLocale(locale)
      set({ locale })
    },

    providerId: 'osm',
    setProviderId: (providerId) =>
      set((state) => ({
        providerId,
        layers: layersFor(providerId, state.layers),
      })),

    panel: 'layers',
    setPanel: (panel) => set({ panel }),
    togglePanel: (panel) =>
      set((state) => ({ panel: state.panel === panel ? null : panel })),

    layers: initialLayers(),
    toggleLayer: (id) =>
      set((state) => ({
        layers: {
          ...state.layers,
          [id]: {
            ...state.layers[id],
            visible: !state.layers[id].visible,
          },
        },
      })),
    setLayerOpacity: (id, opacity) =>
      set((state) => ({
        layers: {
          ...state.layers,
          [id]: { ...state.layers[id], opacity },
        },
      })),

    customSources: [],
    customLayers: {},
    setCustomSources: (customSources) =>
      set((state) => {
        const customLayers = { ...state.customLayers }
        for (const source of customSources) {
          customLayers[source.id] ??= { visible: true, opacity: 1 }
        }
        for (const id of Object.keys(customLayers)) {
          if (!customSources.some((source) => source.id === id)) {
            delete customLayers[id]
          }
        }
        return { customSources, customLayers }
      }),
    toggleCustomLayer: (id) =>
      set((state) => ({
        customLayers: {
          ...state.customLayers,
          [id]: {
            visible: !(state.customLayers[id]?.visible ?? true),
            opacity: state.customLayers[id]?.opacity ?? 1,
          },
        },
      })),
    setCustomLayerOpacity: (id, opacity) =>
      set((state) => ({
        customLayers: {
          ...state.customLayers,
          [id]: {
            visible: state.customLayers[id]?.visible ?? true,
            opacity,
          },
        },
      })),

    vectorLayers: [],
    addVectorLayer: (layer) =>
      set((state) => ({
        ...recordHistory(state, 'vector:add'),
        vectorLayers: [
          ...state.vectorLayers.filter((item) => item.id !== layer.id),
          layer,
        ],
      })),
    removeVectorLayer: (id) =>
      set((state) => ({
        ...recordHistory(state, `vector:remove:${id}`),
        vectorLayers: state.vectorLayers.filter((layer) => layer.id !== id),
        selectedVector:
          state.selectedVector?.layerId === id ? null : state.selectedVector,
      })),
    moveVectorLayer: (id, delta) =>
      set((state) => {
        const vectorLayers = moveLayerItem(state.vectorLayers, id, delta)
        return vectorLayers === state.vectorLayers ? {} : { vectorLayers }
      }),
    reorderVectorLayers: (ids) =>
      set((state) => {
        const vectorLayers = reorderLayerItems(state.vectorLayers, ids)
        return vectorLayers === state.vectorLayers ? {} : { vectorLayers }
      }),
    toggleVectorLayer: (id) =>
      set((state) => ({
        vectorLayers: state.vectorLayers.map((layer) =>
          layer.id === id ? { ...layer, visible: !layer.visible } : layer,
        ),
      })),
    setVectorLayerOpacity: (id, opacity) =>
      set((state) => ({
        vectorLayers: state.vectorLayers.map((layer) =>
          layer.id === id
            ? { ...layer, opacity: Math.max(0, Math.min(1, opacity)) }
            : layer,
        ),
      })),
    setVectorLayerStyle: (id, patch) =>
      set((state) => ({
        vectorLayers: state.vectorLayers.map((layer) =>
          layer.id === id
            ? { ...layer, style: { ...layer.style, ...patch } }
            : layer,
        ),
      })),
    selectedVector: null,
    selectVectorFeature: (selectedVector) =>
      set({ selectedVector, selectedFeatureId: null }),
    moveVectorVertex: (layerId, featureIndex, path, point) =>
      set((state) => {
        const feature = state.vectorLayers
          .find((layer) => layer.id === layerId)
          ?.features[featureIndex]
        const geometry = feature
          ? moveGeometryVertex(feature.geometry, path, point)
          : null
        if (!geometry) return {}
        return {
          ...recordHistory(
            state,
            `vector:vertex:${layerId}:${featureIndex}:${path.join('.')}`,
          ),
          vectorLayers: replaceVectorGeometry(
            state.vectorLayers,
            layerId,
            featureIndex,
            geometry,
          ),
        }
      }),
    insertVectorVertex: (layerId, featureIndex, path, point) =>
      set((state) => {
        const feature = state.vectorLayers
          .find((layer) => layer.id === layerId)
          ?.features[featureIndex]
        const geometry = feature
          ? insertGeometryVertex(feature.geometry, path, point)
          : null
        if (!geometry) return {}
        return {
          ...recordHistory(
            state,
            `vector:insert:${layerId}:${featureIndex}:${path.join('.')}`,
          ),
          vectorLayers: replaceVectorGeometry(
            state.vectorLayers,
            layerId,
            featureIndex,
            geometry,
          ),
        }
      }),
    deleteVectorVertex: (layerId, featureIndex, path) =>
      set((state) => {
        const feature = state.vectorLayers
          .find((layer) => layer.id === layerId)
          ?.features[featureIndex]
        const geometry = feature
          ? deleteGeometryVertex(feature.geometry, path)
          : null
        if (!geometry) return {}
        return {
          ...recordHistory(
            state,
            `vector:delete-vertex:${layerId}:${featureIndex}:${path.join('.')}`,
          ),
          vectorLayers: replaceVectorGeometry(
            state.vectorLayers,
            layerId,
            featureIndex,
            geometry,
          ),
        }
      }),

    packs: [],
    packPaths: [],
    addPack: (pack) =>
      set((state) => ({
        packs: [
          ...state.packs.filter((item) => item.id !== pack.id),
          pack,
        ],
        packPaths: state.packPaths.includes(pack.path)
          ? state.packPaths
          : [...state.packPaths, pack.path],
      })),
    removePack: (id) =>
      set((state) => {
        const pack = state.packs.find((item) => item.id === id)
        return {
          packs: state.packs.filter((item) => item.id !== id),
          packPaths: pack
            ? state.packPaths.filter((path) => path !== pack.path)
            : state.packPaths,
        }
      }),
    movePack: (id, delta) =>
      set((state) => {
        const packs = moveLayerItem(state.packs, id, delta)
        if (packs === state.packs) return {}
        return { packs, packPaths: reorderPackPaths(state.packPaths, packs) }
      }),
    reorderPacks: (ids) =>
      set((state) => {
        const packs = reorderLayerItems(state.packs, ids)
        if (packs === state.packs) return {}
        return { packs, packPaths: reorderPackPaths(state.packPaths, packs) }
      }),
    forgetPackPath: (path) =>
      set((state) => ({
        packPaths: state.packPaths.filter((item) => item !== path),
      })),
    togglePack: (id) =>
      set((state) => ({
        packs: state.packs.map((pack) =>
          pack.id === id ? { ...pack, visible: !pack.visible } : pack,
        ),
      })),
    setPackOpacity: (id, opacity) =>
      set((state) => ({
        packs: state.packs.map((pack) =>
          pack.id === id ? { ...pack, opacity } : pack,
        ),
      })),

    selection: null,
    selectionPolygon: null,
    setSelection: (selection) => set({ selection, selectionPolygon: null }),
    setSelectionPolygon: (selectionPolygon) => set({ selectionPolygon }),
    drawing: false,
    setDrawing: (drawing) =>
      set(
        drawing
          ? {
              drawing,
              // A new rectangle supersedes a polygon mask chosen earlier.
              selectionPolygon: null,
              measureMode: null,
              placingMarker: false,
              featureMode: 'off',
              draftPoints: [],
            }
          : { drawing },
      ),

    measureMode: null,
    measurePoints: [],
    setMeasureMode: (measureMode) =>
      set((state) => ({
        measureMode,
        drawing: false,
        placingMarker: false,
        featureMode: 'off',
        draftPoints: [],
        measurePoints:
          measureMode === state.measureMode ? state.measurePoints : [],
      })),

    features: [],
    featureMode: 'off',
    draftPoints: [],
    selectedFeatureId: null,
    featureColor: FEATURE_COLORS[0],
    setFeatureMode: (featureMode) =>
      set((state) => ({
        featureMode,
        draftPoints:
          featureMode === state.featureMode ? state.draftPoints : [],
        drawing: false,
        measureMode: null,
        placingMarker: false,
        selectedFeatureId:
          featureMode === 'edit' ? state.selectedFeatureId : null,
        selectedVector:
          featureMode === 'edit' ? state.selectedVector : null,
      })),
    setFeatureColor: (featureColor) => set({ featureColor }),
    addDraftPoint: (point) =>
      set((state) =>
        state.draftPoints.length >= MAX_VERTICES
          ? state
          : { draftPoints: [...state.draftPoints, point] },
      ),
    undoDraftPoint: () =>
      set((state) => ({ draftPoints: state.draftPoints.slice(0, -1) })),
    finishDraft: () =>
      set((state) => {
        const circle = state.featureMode === 'draw-circle'
        const kind =
          state.featureMode === 'draw-polygon' || circle
            ? 'polygon'
            : 'line'
        const draft = normalizeDraft(state.draftPoints)
        const points =
          circle && draft.length >= 2
            ? circlePolygon(draft[0], draft[1], 64)
            : draft
        const minimum = kind === 'line' ? 2 : 3
        if (state.featureMode === 'off' || points.length < minimum) {
          return {}
        }
        if (state.features.length >= MAX_FEATURES) {
          return { draftPoints: [], featureMode: 'off' as const }
        }
        const ordinal =
          state.features.filter((item) => item.kind === kind).length + 1
        const feature: MapFeature = {
          id: featureId(),
          name: circle
            ? tr(`Круг ${ordinal}`, `Circle ${ordinal}`)
            : kind === 'line'
              ? tr(`Линия ${ordinal}`, `Line ${ordinal}`)
              : tr(`Полигон ${ordinal}`, `Polygon ${ordinal}`),
          kind,
          coordinates: points,
          color: state.featureColor,
        }
        return {
          ...recordHistory(state, 'feature:add'),
          features: [...state.features, feature],
          draftPoints: [],
          featureMode: 'off' as const,
          selectedFeatureId: feature.id,
        }
      }),
    cancelDraft: () => set({ draftPoints: [], featureMode: 'off' }),
    selectFeature: (selectedFeatureId) => set({ selectedFeatureId }),
    updateFeature: (id, patch) =>
      set((state) => ({
        ...recordHistory(state, `feature:update:${id}`),
        features: state.features.map((feature) =>
          feature.id === id ? { ...feature, ...patch } : feature,
        ),
      })),
    moveFeatureVertex: (id, index, point) =>
      set((state) => ({
        ...recordHistory(state, `feature:vertex:${id}:${index}`),
        features: state.features.map((feature) =>
          feature.id === id
            ? {
                ...feature,
                coordinates: feature.coordinates.map((item, position) =>
                  position === index ? point : item,
                ),
              }
            : feature,
        ),
      })),
    deleteFeatureVertex: (id, index) =>
      set((state) => ({
        ...recordHistory(state, `feature:delete-vertex:${id}:${index}`),
        features: state.features.flatMap((feature) => {
          if (feature.id !== id) return [feature]
          const coordinates = feature.coordinates.filter(
            (_, position) => position !== index,
          )
          const minimum = feature.kind === 'line' ? 2 : 3
          // Keep the object intact at the minimum vertex count; silently
          // deleting a whole polygon from the map context menu is a trap.
          return coordinates.length >= minimum
            ? [{ ...feature, coordinates }]
            : [feature]
        }),
      })),
    appendFeatureVertex: (id) =>
      set((state) => ({
        ...recordHistory(state, `feature:append-vertex:${id}`),
        features: state.features.map((feature) => {
          if (feature.id !== id) return feature
          const coordinates = feature.coordinates
          const last = coordinates[coordinates.length - 1]
          const first = coordinates[0]
          if (!last) return feature
          const point: LonLat =
            feature.kind === 'polygon' && first
              ? [(last[0] + first[0]) / 2, (last[1] + first[1]) / 2]
              : [last[0], last[1]]
          return { ...feature, coordinates: [...coordinates, point] }
        }),
      })),
    removeFeature: (id) =>
      set((state) => ({
        ...recordHistory(state, `feature:remove:${id}`),
        features: state.features.filter((feature) => feature.id !== id),
        selectedFeatureId:
          state.selectedFeatureId === id ? null : state.selectedFeatureId,
      })),
    addFeatures: (incoming) =>
      set((state) => ({
        ...recordHistory(state, 'features:add'),
        features: [...state.features, ...incoming].slice(0, MAX_FEATURES),
      })),
    clearFeatures: () =>
      set((state) => ({
        ...recordHistory(state, 'features:clear'),
        features: [],
        selectedFeatureId: null,
        draftPoints: [],
        featureMode: 'off' as const,
      })),
    addMeasurePoint: (point) =>
      set((state) =>
        state.measurePoints.length >= MAX_VERTICES
          ? state
          : { measurePoints: [...state.measurePoints, point] },
      ),
    undoMeasurePoint: () =>
      set((state) => ({ measurePoints: state.measurePoints.slice(0, -1) })),
    clearMeasure: () => set({ measurePoints: [] }),

    crs: null,
    crsLabel: '',
    setCrs: (crs, crsLabel) => set({ crs, crsLabel }),

    projectName: tr('Мой проект', 'My project'),
    projectPath: null,
    recentProjects: [],
    setProjectMeta: (projectName, projectPath) =>
      set({ projectName, projectPath }),
    addRecentProject: (project) =>
      set((state) => ({
        recentProjects: [
          project,
          ...state.recentProjects.filter((item) => item.path !== project.path),
        ].slice(0, 8),
      })),
    clearRecentProjects: () => set({ recentProjects: [] }),

    markers: [],
    placingMarker: false,
    selectedMarkerId: null,
    coordinateFormat: 'dd',
    setPlacingMarker: (placingMarker) =>
      set(
        placingMarker
          ? {
              placingMarker,
              drawing: false,
              measureMode: null,
              featureMode: 'off',
              draftPoints: [],
            }
          : { placingMarker },
      ),
    setSelectedMarker: (selectedMarkerId) => set({ selectedMarkerId }),
    addMarker: (marker) =>
      set((state) => ({
        ...recordHistory(state, 'marker:add'),
        markers: [...state.markers, marker],
        selectedMarkerId: marker.id,
      })),
    addMarkers: (incoming) =>
      set((state) => ({
        ...recordHistory(state, 'markers:add'),
        markers: [...state.markers, ...incoming],
      })),
    updateMarker: (id, patch) =>
      set((state) => ({
        ...recordHistory(state, `marker:update:${id}`),
        markers: state.markers.map((marker) =>
          marker.id === id ? { ...marker, ...patch } : marker,
        ),
      })),
    removeMarker: (id) =>
      set((state) => ({
        ...recordHistory(state, `marker:remove:${id}`),
        markers: state.markers.filter((marker) => marker.id !== id),
        selectedMarkerId:
          state.selectedMarkerId === id ? null : state.selectedMarkerId,
      })),
    clearMarkers: () =>
      set((state) => ({
        ...recordHistory(state, 'markers:clear'),
        markers: [],
        selectedMarkerId: null,
      })),
    setCoordinateFormat: (coordinateFormat) => set({ coordinateFormat }),

    commandOpen: false,
    setCommandOpen: (commandOpen) => set({ commandOpen }),

    shortcutsOpen: false,
    setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),

    downloadOpen: false,
    setDownloadOpen: (downloadOpen) => set({ downloadOpen }),

    fieldMode: false,
    toggleFieldMode: () => set((state) => ({ fieldMode: !state.fieldMode })),

    snapping: true,
    toggleSnapping: () => set((state) => ({ snapping: !state.snapping })),
    mapGrid: false,
    toggleMapGrid: () => set((state) => ({ mapGrid: !state.mapGrid })),

    packLicense: '',
    setPackLicense: (packLicense) =>
      set({ packLicense: packLicense.slice(0, 200) }),

    autosaveEnabled: true,
    setAutosaveEnabled: (autosaveEnabled) => set({ autosaveEnabled }),

    toast: null,
    showToast: (message) =>
      set({ toast: { id: Date.now(), message } }),
    clearToast: () => set({ toast: null }),
  }),
)

/**
 * Restores the allowlisted persisted fields. Unknown keys are ignored, so an
 * old or hand-edited localStorage blob cannot inject actions or selectors.
 */
const restorePersisted = () => {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return
  }
  if (!raw) return
  try {
    const parsed = JSON.parse(raw) as { state?: unknown }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.state ||
      typeof parsed.state !== 'object'
    ) {
      return
    }
    const saved = parsed.state as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    for (const key of PERSISTED_KEYS) {
      if (saved[key] !== undefined) patch[key] = saved[key]
    }
    if (!Array.isArray(patch.recentProjects)) {
      delete patch.recentProjects
    } else {
      patch.recentProjects = patch.recentProjects
        .filter(
          (item): item is RecentProject =>
            Boolean(
              item &&
                typeof item === 'object' &&
                typeof (item as RecentProject).name === 'string' &&
                typeof (item as RecentProject).path === 'string' &&
                typeof (item as RecentProject).at === 'number',
            ),
        )
        .slice(0, 8)
    }
    if (typeof patch.snapping !== 'boolean') delete patch.snapping
    if (patch.locale !== 'ru' && patch.locale !== 'en') delete patch.locale
    else setActiveLocale(patch.locale as Locale)
    const providerId = PROVIDERS.some(
      (provider) => provider.id === patch.providerId,
    )
      ? (patch.providerId as ProviderId)
      : 'osm'
    // `layers` is derived from `providerId`; never restore stale visibility.
    useAppStore.setState({
      ...(patch as Partial<AppState>),
      providerId,
      layers: layersFor(providerId),
    })
  } catch (error) {
    console.warn('cannot restore workspace', error)
  }
}

if (typeof window !== 'undefined') {
  restorePersisted()
  useAppStore.subscribe((state, previous) => {
    if (PERSISTED_KEYS.some((key) => state[key] !== previous[key])) {
      schedulePersist()
    }
  })
  window.addEventListener('pagehide', flushPersisted)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersisted()
  })
}
