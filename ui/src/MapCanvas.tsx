import { useEffect, useRef, useState } from 'react'
import {
  Map as MapLibreMap,
  Marker as MapLibreMarker,
  type GeoJSONSource,
  type MapMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import {
  bearing,
  distance,
  formatArea,
  formatAzimuth,
  formatDistance,
  midpoint,
  pathLength,
  polygonArea,
  polygonPerimeter,
  tileBounds,
  type LonLat,
} from './geo'
import type { CustomSource } from './customSources'
import type { CoverageTile } from './coverage'
import type { VectorLayer } from './vectorLayers.ts'
import { geometryVertices, type VertexPath } from './geometryEdit.ts'
import { graticule, gridLabel } from './graticule.ts'
import type { Geometry, Position } from 'geojson'
import {
  closeRing,
  type FeatureMode,
  type MapFeature,
} from './features'
import type { MapMarker } from './markers'
import {
  providerTiles,
  registerNativeTileProtocol,
} from './native'
import { PROVIDERS, type ProviderId } from './providers'
import type {
  LayerState,
  MapView,
  MeasureMode,
  PackLayer,
  Theme,
} from './store'
import type { Bounds } from './format'
import { useViewStore } from './viewStore'
import { useT } from './i18n.ts'

interface MapCanvasProps {
  layers: LayerState
  providerId: ProviderId
  packs: PackLayer[]
  customSources: CustomSource[]
  customLayers: Record<string, { visible: boolean; opacity: number }>
  theme: Theme
  selection: Bounds | null
  selectionPolygon: LonLat[] | null
  coverageTiles: CoverageTile[] | null
  vectorLayers: VectorLayer[]
  snapping: boolean
  grid: boolean
  drawing: boolean
  measureMode: MeasureMode
  measurePoints: LonLat[]
  features: MapFeature[]
  featureMode: FeatureMode
  draftPoints: LonLat[]
  selectedFeatureId: string | null
  selectedVector: { layerId: string; featureIndex: number } | null
  markers: MapMarker[]
  selectedMarkerId: string | null
  placingMarker: boolean
  onViewChange: (view: MapView) => void
  onCursor: (coords: [number, number] | null) => void
  onMapError: (message: string) => void
  onSelectionChange: (selection: Bounds | null) => void
  onDrawingChange: (drawing: boolean) => void
  onMeasurePoint: (point: LonLat) => void
  onAddDraftPoint: (point: LonLat) => void
  onFinishDraft: () => void
  onSelectFeature: (id: string | null) => void
  onMoveFeatureVertex: (id: string, index: number, point: LonLat) => void
  onDeleteFeatureVertex: (id: string, index: number) => void
  onSelectVectorFeature: (
    selection: { layerId: string; featureIndex: number } | null,
  ) => void
  onMoveVectorVertex: (
    layerId: string,
    featureIndex: number,
    path: VertexPath,
    point: LonLat,
  ) => void
  onInsertVectorVertex: (
    layerId: string,
    featureIndex: number,
    path: VertexPath,
    point: LonLat,
  ) => void
  onDeleteVectorVertex: (
    layerId: string,
    featureIndex: number,
    path: VertexPath,
  ) => void
  onPlaceMarker: (point: LonLat) => void
  onMoveMarker: (id: string, point: LonLat) => void
  onSelectMarker: (id: string | null) => void
  onReady: (map: MapLibreMap) => void
}

const rectBounds = (
  start: [number, number],
  end: [number, number],
): Bounds => [
  [Math.min(start[0], end[0]), Math.min(start[1], end[1])],
  [Math.max(start[0], end[0]), Math.max(start[1], end[1])],
]

const EMPTY_SELECTION = { type: 'FeatureCollection' as const, features: [] }

const SNAP_RADIUS_PX = 11

const nearestOnSegment = (
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { x: number; y: number; distance: number } => {
  const dx = bx - ax
  const dy = by - ay
  const length = dx * dx + dy * dy
  const t =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length))
  const px = ax + t * dx
  const py = ay + t * dy
  return { x: px, y: py, distance: Math.hypot(x - px, y - py) }
}

/**
 * Snaps a click to the nearest vertex or edge of drawn and imported vectors.
 * MapLibre's rendered-feature index keeps this independent of layer size.
 */
function snapToVectors(
  map: MapLibreMap,
  target: LonLat,
): { point: LonLat; snapped: boolean } {
  const candidates = (map.getStyle().layers ?? [])
    .map((layer) => layer.id)
    .filter(
      (id) =>
        id === 'feature-line' ||
        id === 'feature-fill' ||
        id.startsWith('vector-'),
    )
  if (candidates.length === 0) return { point: target, snapped: false }
  const origin = map.project([target[0], target[1]])
  let best: LonLat | null = null
  let bestDistance = SNAP_RADIUS_PX

  const visitVertex = (position: Position) => {
    const point = map.project([position[0], position[1]])
    const distance = Math.hypot(point.x - origin.x, point.y - origin.y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = [position[0], position[1]]
    }
  }
  const visitLine = (coordinates: Position[]) => {
    coordinates.forEach(visitVertex)
    for (let index = 1; index < coordinates.length; index += 1) {
      const left = map.project([
        coordinates[index - 1][0],
        coordinates[index - 1][1],
      ])
      const right = map.project([
        coordinates[index][0],
        coordinates[index][1],
      ])
      const nearest = nearestOnSegment(
        origin.x,
        origin.y,
        left.x,
        left.y,
        right.x,
        right.y,
      )
      if (nearest.distance < bestDistance) {
        bestDistance = nearest.distance
        const point = map.unproject([nearest.x, nearest.y])
        best = [point.lng, point.lat]
      }
    }
  }
  const visitGeometry = (geometry: Geometry | undefined) => {
    if (!geometry) return
    switch (geometry.type) {
      case 'Point':
        visitVertex(geometry.coordinates)
        break
      case 'MultiPoint':
        geometry.coordinates.forEach(visitVertex)
        break
      case 'LineString':
        visitLine(geometry.coordinates)
        break
      case 'MultiLineString':
        geometry.coordinates.forEach(visitLine)
        break
      case 'Polygon':
        geometry.coordinates.forEach(visitLine)
        break
      case 'MultiPolygon':
        geometry.coordinates.forEach((polygon) =>
          polygon.forEach(visitLine),
        )
        break
      case 'GeometryCollection':
        geometry.geometries.forEach(visitGeometry)
        break
    }
  }

  try {
    const hits = map.queryRenderedFeatures(
      [
        [origin.x - SNAP_RADIUS_PX, origin.y - SNAP_RADIUS_PX],
        [origin.x + SNAP_RADIUS_PX, origin.y + SNAP_RADIUS_PX],
      ],
      { layers: candidates },
    )
    for (const hit of hits) {
      visitGeometry(hit.geometry as Geometry | undefined)
    }
  } catch {
    // The style may be mid-reload; an unsnapped point is always safe.
  }
  return best ? { point: best, snapped: true } : { point: target, snapped: false }
}

function setSnapIndicator(map: MapLibreMap, point: LonLat | null): void {
  const source = map.getSource('snap-point') as GeoJSONSource | undefined
  source?.setData(
    (point
      ? {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: point },
        }
      : EMPTY_SELECTION) as never,
  )
}

/** Above this count pins are drawn as a GPU layer without HTML labels. */
const HTML_MARKER_LIMIT = 250
/** Status-bar/viewport updates are intentionally below display refresh rate. */
const VIEW_INTERVAL_MS = 120
const CURSOR_INTERVAL_MS = 80

const selectionFeature = (bounds: Bounds) => ({
  type: 'Feature' as const,
  properties: {},
  geometry: {
    type: 'Polygon' as const,
    coordinates: [
      [
        [bounds[0][0], bounds[0][1]],
        [bounds[1][0], bounds[0][1]],
        [bounds[1][0], bounds[1][1]],
        [bounds[0][0], bounds[1][1]],
        [bounds[0][0], bounds[0][1]],
      ],
    ],
  },
})

const coverageData = (tiles: CoverageTile[] | null) => ({
  type: 'FeatureCollection' as const,
  features: (tiles ?? []).map(([z, x, y]) => {
    const [[west, south], [east, north]] = tileBounds(z, x, y)
    return {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
          ],
        ],
      },
    }
  }),
})

const selectionPolygonFeature = (ring: LonLat[]) => ({
  type: 'Feature' as const,
  properties: {},
  geometry: {
    type: 'Polygon' as const,
    coordinates: [[...ring, ring[0]]],
  },
})

const applySelection = (
  map: MapLibreMap,
  bounds: Bounds | null,
  polygon: LonLat[] | null = null,
) => {
  const source = map.getSource('selection') as GeoJSONSource | undefined
  source?.setData(
    polygon && polygon.length >= 3
      ? selectionPolygonFeature(polygon)
      : bounds
        ? selectionFeature(bounds)
        : EMPTY_SELECTION,
  )
}

const pointFeature = (point: LonLat) => ({
  type: 'Feature' as const,
  properties: {},
  geometry: { type: 'Point' as const, coordinates: point },
})

const measureData = (points: LonLat[], mode: MeasureMode) => {
  const features: object[] = points.map(pointFeature)
  if (points.length >= 2) {
    features.push({
      type: 'Feature',
      properties: { kind: 'line' },
      geometry: { type: 'LineString', coordinates: points },
    })
  }
  if (mode === 'area' && points.length >= 3) {
    features.push({
      type: 'Feature',
      properties: { kind: 'area' },
      geometry: {
        type: 'Polygon',
        coordinates: [[...points, points[0]]],
      },
    })
  }
  return { type: 'FeatureCollection', features }
}

const featureData = (features: MapFeature[]) => ({
  type: 'FeatureCollection' as const,
  features: features.map((feature) => ({
    type: 'Feature' as const,
    properties: {
      id: feature.id,
      name: feature.name,
      color: feature.color,
      kind: feature.kind,
    },
    geometry:
      feature.kind === 'line'
        ? {
            type: 'LineString' as const,
            coordinates: feature.coordinates,
          }
        : {
            type: 'Polygon' as const,
            coordinates: [closeRing(feature.coordinates)],
          },
  })),
})

const vertexData = (feature: MapFeature | undefined) => ({
  type: 'FeatureCollection' as const,
  features: feature
    ? feature.coordinates.map((coordinate, index) => ({
        type: 'Feature' as const,
        properties: { featureId: feature.id, index },
        geometry: { type: 'Point' as const, coordinates: coordinate },
      }))
    : [],
})

/** Outline plus draggable vertices for the selected imported feature. */
const vectorEditData = (
  layers: VectorLayer[],
  selection: { layerId: string; featureIndex: number } | null,
) => {
  const feature = selection
    ? layers.find((layer) => layer.id === selection.layerId)?.features[
        selection.featureIndex
      ]
    : undefined
  const outline = {
    type: 'FeatureCollection' as const,
    features: feature ? [feature] : [],
  }
  const vertices = (feature ? geometryVertices(feature.geometry) : []).map(
    (vertex) => ({
      type: 'Feature' as const,
      properties: {
        layerId: selection?.layerId,
        featureIndex: selection?.featureIndex,
        path: vertex.path,
        kind: vertex.kind,
      },
      geometry: { type: 'Point' as const, coordinates: vertex.position },
    }),
  )
  return {
    outline,
    vertices: { type: 'FeatureCollection' as const, features: vertices },
  }
}

const draftData = (points: LonLat[], mode: FeatureMode) => {
  const features: object[] = points.map(pointFeature)
  if (points.length >= 2) {
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: points },
    })
  }
  if (mode === 'draw-polygon' && points.length >= 3) {
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [closeRing(points)] },
    })
  }
  return { type: 'FeatureCollection', features }
}

/** Keeps drawing affordances above MBTiles/PMTiles pack layers. */
const FEATURE_LAYER_ORDER = [
  'feature-fill',
  'feature-line',
  'feature-vertices',
  'vector-edit-outline',
  'vector-vertices-edit',
  'vector-midpoints-edit',
  'feature-draft-fill',
  'feature-draft-line',
  'feature-draft-points',
  'feature-preview-line',
  'measure-fill',
  'measure-line',
  'measure-preview-line',
  'measure-point',
  'selection-fill',
  'selection-outline',
  'marker-points',
]

const raiseFeatureLayers = (map: MapLibreMap) => {
  for (const id of FEATURE_LAYER_ORDER) {
    if (map.getLayer(id)) map.moveLayer(id)
  }
}

const measureLabel = (text: string, variant = ''): HTMLDivElement => {
  const element = document.createElement('div')
  element.className = `measure-label${variant ? ` ${variant}` : ''}`
  element.textContent = text
  return element
}

const applyMarkerStyle = (
  element: HTMLDivElement,
  marker: MapMarker,
): void => {
  const pin = element.querySelector<HTMLElement>('.map-marker-pin')
  if (!pin) return
  if (marker.color) pin.style.setProperty('--marker-color', marker.color)
  else pin.style.removeProperty('--marker-color')
  if (marker.icon) pin.dataset.icon = marker.icon
  else delete pin.dataset.icon
}

const markerElement = (
  marker: MapMarker,
  selected: boolean,
): HTMLDivElement => {
  const element = document.createElement('div')
  element.className = `map-marker${selected ? ' is-selected' : ''}`
  element.title = marker.description
    ? `${marker.name}\n${marker.description}`
    : marker.name
  const pin = document.createElement('span')
  pin.className = 'map-marker-pin'
  const label = document.createElement('span')
  label.className = 'map-marker-label'
  label.textContent = marker.name
  element.append(label, pin)
  applyMarkerStyle(element, marker)
  return element
}

const buildStyle = (active: ProviderId): StyleSpecification => {
  const sources = Object.fromEntries(
    PROVIDERS.map((provider) => [
      provider.id,
      {
        type: 'raster',
        tiles: providerTiles(provider.id, provider.tiles),
        tileSize: provider.tileSize,
        maxzoom: provider.maxZoom,
        attribution: provider.attribution,
      },
    ]),
  )

  return {
    version: 8,
    sources,
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#0e1116' },
      },
      ...PROVIDERS.map((provider) => ({
        id: provider.id,
        type: 'raster' as const,
        source: provider.id,
        layout: {
          visibility: provider.id === active ? 'visible' : 'none',
        },
        paint: {
          'raster-opacity': 1,
          'raster-resampling': 'linear' as const,
          'raster-fade-duration': 0,
        },
      })),
    ],
  } as StyleSpecification
}

export function MapCanvas({
  layers,
  providerId,
  packs,
  customSources,
  customLayers,
  theme,
  selection,
  selectionPolygon,
  coverageTiles,
  vectorLayers,
  snapping,
  grid,
  drawing,
  measureMode,
  measurePoints,
  features,
  featureMode,
  draftPoints,
  selectedFeatureId,
  selectedVector,
  markers,
  selectedMarkerId,
  placingMarker,
  onViewChange,
  onCursor,
  onMapError,
  onSelectionChange,
  onDrawingChange,
  onMeasurePoint,
  onAddDraftPoint,
  onFinishDraft,
  onSelectFeature,
  onMoveFeatureVertex,
  onDeleteFeatureVertex,
  onSelectVectorFeature,
  onMoveVectorVertex,
  onInsertVectorVertex,
  onDeleteVectorVertex,
  onPlaceMarker,
  onMoveMarker,
  onSelectMarker,
  onReady,
}: MapCanvasProps) {
  const t = useT()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const packIdsRef = useRef<Set<string>>(new Set())
  const vectorLayerIdsRef = useRef<Set<string>>(new Set())
  const vectorDataRef = useRef<Map<string, VectorLayer['features']>>(new Map())
  const customIdsRef = useRef<Set<string>>(new Set())
  const customConfigsRef = useRef<Map<string, string>>(new Map())
  const selectionRef = useRef<Bounds | null>(selection)
  const selectionPolygonRef = useRef<LonLat[] | null>(selectionPolygon)
  const measureLabelsRef = useRef<MapLibreMarker[]>([])
  const mapMarkersRef = useRef<
    Map<string, { handle: MapLibreMarker; element: HTMLDivElement }>
  >(new Map())
  const [ready, setReady] = useState(false)
  const providerIdRef = useRef(providerId)
  const draftPointsRef = useRef(draftPoints)
  const onViewRef = useRef(onViewChange)
  const onCursorRef = useRef(onCursor)
  const onReadyRef = useRef(onReady)
  const onMapErrorRef = useRef(onMapError)

  useEffect(() => {
    providerIdRef.current = providerId
  }, [providerId])

  useEffect(() => {
    draftPointsRef.current = draftPoints
  }, [draftPoints])

  useEffect(() => {
    onViewRef.current = onViewChange
  }, [onViewChange])

  useEffect(() => {
    onCursorRef.current = onCursor
  }, [onCursor])

  useEffect(() => {
    onMapErrorRef.current = onMapError
  }, [onMapError])

  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    registerNativeTileProtocol()
    const initialView = useViewStore.getState().mapView
    const map = new MapLibreMap({
      container: containerRef.current,
      style: buildStyle(providerIdRef.current),
      center: initialView.center,
      zoom: initialView.zoom,
      minZoom: 1,
      maxZoom: 20,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      // Raster tiles already arrive ready-to-draw; cross-fading every
      // loaded tile keeps the compositor busy long after the pan stops.
      fadeDuration: 0,
    })

    mapRef.current = map
    map.touchZoomRotate.disableRotation()

    let frame = 0
    let trailing = 0
    let lastView = 0
    const emitView = () => {
      frame = 0
      lastView = performance.now()
      const center = map.getCenter()
      const bounds = map.getBounds()
      const box: Bounds = [
        [bounds.getWest(), bounds.getSouth()],
        [bounds.getEast(), bounds.getNorth()],
      ]
      const midLat = (bounds.getSouth() + bounds.getNorth()) / 2
      const widthPx = Math.max(1, map.getCanvas().clientWidth)
      const widthMeters =
        ((bounds.getEast() - bounds.getWest()) *
          111_320 *
          Math.cos((midLat * Math.PI) / 180))
      onViewRef.current({
        center: [center.lng, center.lat],
        zoom: map.getZoom(),
        bounds: box,
        scale: (widthMeters / widthPx) * 3779.527559,
      })
    }
    const scheduleView = () => {
      if (frame !== 0 || trailing !== 0) return
      const wait = VIEW_INTERVAL_MS - (performance.now() - lastView)
      if (wait <= 0) {
        frame = requestAnimationFrame(emitView)
        return
      }
      trailing = window.setTimeout(() => {
        trailing = 0
        if (frame === 0) frame = requestAnimationFrame(emitView)
      }, wait)
    }
    const emitNow = () => {
      if (trailing !== 0) {
        window.clearTimeout(trailing)
        trailing = 0
      }
      if (frame !== 0) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      emitView()
    }

    let lastCursorAt = 0
    let lastCursor: [number, number] | null = null
    const onMouseMove = (event: MapMouseEvent) => {
      const now = performance.now()
      if (now - lastCursorAt < CURSOR_INTERVAL_MS) return
      lastCursorAt = now
      const next: [number, number] = [event.lngLat.lng, event.lngLat.lat]
      if (
        lastCursor &&
        lastCursor[0].toFixed(5) === next[0].toFixed(5) &&
        lastCursor[1].toFixed(5) === next[1].toFixed(5)
      ) {
        return
      }
      lastCursor = next
      onCursorRef.current(next)
    }
    const onMouseOut = () => {
      lastCursor = null
      onCursorRef.current(null)
    }

    map.on('load', () => {
      map.resize()
      map.addSource('coverage', {
        type: 'geojson',
        data: coverageData(null),
      })
      map.addLayer({
        id: 'coverage-fill',
        type: 'fill',
        source: 'coverage',
        paint: { 'fill-color': '#43d9c5', 'fill-opacity': 0.14 },
      })
      map.addLayer({
        id: 'coverage-outline',
        type: 'line',
        source: 'coverage',
        paint: {
          'line-color': '#43d9c5',
          'line-width': 0.6,
          'line-opacity': 0.35,
        },
      })
      map.addSource('selection', {
        type: 'geojson',
        data: EMPTY_SELECTION,
      })
      map.addLayer({
        id: 'selection-fill',
        type: 'fill',
        source: 'selection',
        paint: { 'fill-color': '#3ddc97', 'fill-opacity': 0.16 },
      })
      map.addLayer({
        id: 'selection-outline',
        type: 'line',
        source: 'selection',
        paint: {
          'line-color': '#3ddc97',
          'line-width': 1.5,
          'line-dasharray': [2, 1.5],
        },
      })

      map.addSource('markers', {
        type: 'geojson',
        data: EMPTY_SELECTION,
      })
      map.addLayer({
        id: 'marker-points',
        type: 'circle',
        source: 'markers',
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 5,
          'circle-color': [
            'coalesce',
            ['get', 'marker-color'],
            '#ff7a45',
          ],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.95,
        },
      })

      map.addSource('features', {
        type: 'geojson',
        data: EMPTY_SELECTION,
      })
      map.addLayer({
        id: 'feature-fill',
        type: 'fill',
        source: 'features',
        filter: ['==', ['get', 'kind'], 'polygon'],
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.16 },
      })
      map.addLayer({
        id: 'feature-line',
        type: 'line',
        source: 'features',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2.2,
          'line-opacity': 0.95,
        },
      })
      map.addSource('feature-vertices', {
        type: 'geojson',
        data: EMPTY_SELECTION,
      })
      map.addLayer({
        id: 'feature-vertices',
        type: 'circle',
        source: 'feature-vertices',
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 6,
          'circle-color': '#ffffff',
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#4cc9f0',
        },
      })

      map.addSource('vector-edit', {
        type: 'geojson',
        data: EMPTY_SELECTION,
      })
      map.addLayer({
        id: 'vector-edit-outline',
        type: 'line',
        source: 'vector-edit',
        layout: { visibility: 'none' },
        paint: {
          'line-color': '#ffd166',
          'line-width': 2.5,
          'line-dasharray': [1.5, 1],
        },
      })
      map.addSource('vector-vertices-edit', {
        type: 'geojson',
        data: EMPTY_SELECTION,
      })
      map.addLayer({
        id: 'vector-vertices-edit',
        type: 'circle',
        source: 'vector-vertices-edit',
        filter: ['==', ['get', 'kind'], 'vertex'],
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 6,
          'circle-color': '#ffffff',
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffd166',
        },
      })
      map.addLayer({
        id: 'vector-midpoints-edit',
        type: 'circle',
        source: 'vector-vertices-edit',
        filter: ['==', ['get', 'kind'], 'midpoint'],
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 3.5,
          'circle-color': '#ffd166',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#0b1016',
          'circle-opacity': 0.85,
        },
      })

      map.addSource('feature-draft', {
        type: 'geojson',
        data: EMPTY_SELECTION,
      })
      map.addLayer({
        id: 'feature-draft-fill',
        type: 'fill',
        source: 'feature-draft',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#4cc9f0', 'fill-opacity': 0.12 },
      })
      map.addLayer({
        id: 'feature-draft-line',
        type: 'line',
        source: 'feature-draft',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: { 'line-color': '#4cc9f0', 'line-width': 2.2 },
      })
      map.addLayer({
        id: 'feature-draft-points',
        type: 'circle',
        source: 'feature-draft',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 4,
          'circle-color': '#4cc9f0',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#0b1016',
        },
      })
      map.addSource('feature-preview', {
        type: 'geojson',
        data: EMPTY_SELECTION,
      })
      map.addLayer({
        id: 'feature-preview-line',
        type: 'line',
        source: 'feature-preview',
        paint: {
          'line-color': '#4cc9f0',
          'line-width': 1.5,
          'line-dasharray': [2, 2],
          'line-opacity': 0.8,
        },
      })

      map.addSource('snap-point', {
        type: 'geojson',
        data: EMPTY_SELECTION,
      })
      map.addLayer({
        id: 'snap-point',
        type: 'circle',
        source: 'snap-point',
        paint: {
          'circle-radius': 7,
          'circle-color': '#ffd166',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#0b1016',
          'circle-opacity': 0.95,
        },
      })

      map.addSource('measure', {
        type: 'geojson',
        data: EMPTY_SELECTION,
      })
      map.addSource('measure-preview', {
        type: 'geojson',
        data: EMPTY_SELECTION,
      })
      map.addLayer({
        id: 'measure-fill',
        type: 'fill',
        source: 'measure',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#4cc9f0', 'fill-opacity': 0.14 },
      })
      map.addLayer({
        id: 'measure-line',
        type: 'line',
        source: 'measure',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: { 'line-color': '#4cc9f0', 'line-width': 2 },
      })
      map.addLayer({
        id: 'measure-preview-line',
        type: 'line',
        source: 'measure-preview',
        paint: {
          'line-color': '#4cc9f0',
          'line-width': 1.5,
          'line-dasharray': [2, 2],
          'line-opacity': 0.75,
        },
      })
      map.addLayer({
        id: 'measure-point',
        type: 'circle',
        source: 'measure',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 4,
          'circle-color': '#4cc9f0',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#0b1016',
        },
      })
      raiseFeatureLayers(map)
      applySelection(
        map,
        selectionRef.current,
        selectionPolygonRef.current,
      )
      emitNow()
      setReady(true)
      onReadyRef.current(map)
    })
    map.on('move', scheduleView)
    map.on('zoom', scheduleView)
    map.on('moveend', emitNow)
    map.on('zoomend', emitNow)
    map.on('mousemove', onMouseMove)
    map.on('mouseout', onMouseOut)

    const onError = (event: { error?: { message?: string } }) => {
      const message = event.error?.message ?? ''
      if (
        !message ||
        message.includes('aborted') ||
        message.includes('cancelled')
      ) {
        return
      }
      onMapErrorRef.current(message)
    }
    map.on('error', onError)

    // MapLibre already watches the container with a ResizeObserver; a second
    // one here only doubled resize work and triggered redundant repaints.

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      if (trailing !== 0) window.clearTimeout(trailing)
      map.off('move', scheduleView)
      map.off('zoom', scheduleView)
      map.off('moveend', emitNow)
      map.off('zoomend', emitNow)
      map.off('mousemove', onMouseMove)
      map.off('mouseout', onMouseOut)
      map.off('error', onError)
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return

    for (const provider of PROVIDERS) {
      if (!map.getLayer(provider.id)) continue
      const layer = layers[provider.id]
      map.setLayoutProperty(
        provider.id,
        'visibility',
        layer.visible ? 'visible' : 'none',
      )
      map.setPaintProperty(provider.id, 'raster-opacity', layer.opacity)
    }
  }, [layers, ready])

  useEffect(() => {
    selectionRef.current = selection
    selectionPolygonRef.current = selectionPolygon
    const map = mapRef.current
    if (!ready || !map) return
    applySelection(map, selection, selectionPolygon)
  }, [selection, selectionPolygon, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const source = map.getSource('coverage') as GeoJSONSource | undefined
    source?.setData(coverageData(coverageTiles))
  }, [coverageTiles, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const removeGrid = () => {
      for (const id of ['graticule-line', 'graticule-casing']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      if (map.getSource('graticule')) map.removeSource('graticule')
    }
    if (!grid) {
      removeGrid()
      return
    }
    const color = theme === 'dark' ? '#b8c7d9' : '#40536b'
    if (!map.getSource('graticule')) {
      map.addSource('graticule', {
        type: 'geojson',
        data: EMPTY_SELECTION,
      })
      const before = map.getLayer('selection-fill')
        ? 'selection-fill'
        : undefined
      map.addLayer(
        {
          id: 'graticule-casing',
          type: 'line',
          source: 'graticule',
          paint: {
            'line-color': theme === 'dark' ? '#0b1016' : '#ffffff',
            'line-width': 2.4,
            'line-opacity': 0.35,
          },
        },
        before,
      )
      map.addLayer(
        {
          id: 'graticule-line',
          type: 'line',
          source: 'graticule',
          paint: {
            'line-color': color,
            'line-width': 0.9,
            'line-opacity': 0.55,
          },
        },
        before,
      )
    }
    let labels: MapLibreMarker[] = []
    const render = () => {
      const bounds = map.getBounds()
      const data = graticule(
        [
          [bounds.getWest(), bounds.getSouth()],
          [bounds.getEast(), bounds.getNorth()],
        ],
        map.getZoom(),
      )
      const source = map.getSource('graticule') as GeoJSONSource | undefined
      source?.setData({
        type: 'FeatureCollection',
        features: data.lines.map((line) => ({
          type: 'Feature',
          properties: { axis: line.axis, value: line.value },
          geometry: { type: 'LineString', coordinates: line.coordinates },
        })),
      } as never)

      for (const marker of labels) marker.remove()
      labels = []
      const canvas = map.getCanvas()
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      const center = map.getCenter()
      const place = (text: string, point: [number, number]) => {
        const element = document.createElement('div')
        element.className = 'grid-label'
        element.textContent = text
        labels.push(
          new MapLibreMarker({ element, anchor: 'top' })
            .setLngLat(point)
            .addTo(map),
        )
      }
      for (const lon of data.lons) {
        const x = map.project([lon, center.lat]).x
        if (x < 16 || x > width - 16) continue
        const point = map.unproject([x, 18])
        place(gridLabel(lon, 'lon'), [point.lng, point.lat])
      }
      for (const lat of data.lats) {
        const y = map.project([center.lng, lat]).y
        if (y < 16 || y > height - 16) continue
        const point = map.unproject([42, y])
        place(gridLabel(lat, 'lat'), [point.lng, point.lat])
      }
    }
    render()
    map.on('moveend', render)
    map.on('zoomend', render)
    return () => {
      map.off('moveend', render)
      map.off('zoomend', render)
      for (const marker of labels) marker.remove()
      labels = []
      removeGrid()
    }
  }, [grid, ready, theme])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const active = new Set<string>()
    for (const layer of vectorLayers) {
      const id = layer.id
      const sourceId = `vector-${id}`
      active.add(id)
      const data = {
        type: 'FeatureCollection' as const,
        features: layer.features.map((feature, index) => ({
          ...feature,
          // Selection needs the array index; MapLibre does not expose it.
          properties: { ...(feature.properties ?? {}), __mappaIndex: index },
        })),
      }
      const source = map.getSource(sourceId) as GeoJSONSource | undefined
      if (!source) {
        map.addSource(sourceId, { type: 'geojson', data })
        const before = map.getLayer('selection-fill')
          ? 'selection-fill'
          : undefined
        map.addLayer(
          {
            id: `${sourceId}-fill`,
            type: 'fill',
            source: sourceId,
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: {
              'fill-color': layer.style.color,
              'fill-opacity': layer.style.fillOpacity * layer.opacity,
            },
          },
          before,
        )
        map.addLayer(
          {
            id: `${sourceId}-line`,
            type: 'line',
            source: sourceId,
            paint: {
              'line-color': layer.style.color,
              'line-width': layer.style.lineWidth,
              'line-opacity': layer.opacity,
            },
          },
          before,
        )
        map.addLayer(
          {
            id: `${sourceId}-point`,
            type: 'circle',
            source: sourceId,
            filter: ['==', ['geometry-type'], 'Point'],
            paint: {
              'circle-radius': layer.style.pointRadius,
              'circle-color': layer.style.color,
              'circle-stroke-width': 1,
              'circle-stroke-color': '#0b0f14',
              'circle-opacity': layer.opacity,
            },
          },
          before,
        )
      } else if (vectorDataRef.current.get(id) !== layer.features) {
        source.setData(data)
      }
      vectorDataRef.current.set(id, layer.features)
      const visibility = layer.visible ? 'visible' : 'none'
      for (const suffix of ['fill', 'line', 'point']) {
        const layerId = `${sourceId}-${suffix}`
        if (!map.getLayer(layerId)) continue
        map.setLayoutProperty(layerId, 'visibility', visibility)
      }
      map.setPaintProperty(`${sourceId}-fill`, 'fill-color', [
        'to-string',
        ['coalesce', ['get', 'fill'], layer.style.color],
      ])
      map.setPaintProperty(`${sourceId}-fill`, 'fill-opacity', [
        '*',
        [
          'to-number',
          ['coalesce', ['get', 'fill-opacity'], layer.style.fillOpacity],
        ],
        layer.opacity,
      ])
      map.setPaintProperty(`${sourceId}-line`, 'line-color', [
        'to-string',
        ['coalesce', ['get', 'stroke'], layer.style.color],
      ])
      map.setPaintProperty(`${sourceId}-line`, 'line-width', [
        'to-number',
        ['coalesce', ['get', 'stroke-width'], layer.style.lineWidth],
      ])
      map.setPaintProperty(`${sourceId}-line`, 'line-opacity', [
        '*',
        ['to-number', ['coalesce', ['get', 'stroke-opacity'], 1]],
        layer.opacity,
      ])
      map.setPaintProperty(
        `${sourceId}-point`,
        'circle-radius',
        layer.style.pointRadius,
      )
      map.setPaintProperty(`${sourceId}-point`, 'circle-color', [
        'to-string',
        ['coalesce', ['get', 'marker-color'], layer.style.color],
      ])
      map.setPaintProperty(`${sourceId}-point`, 'circle-opacity', layer.opacity)
    }
    for (const id of vectorLayerIdsRef.current) {
      if (active.has(id)) continue
      const sourceId = `vector-${id}`
      for (const suffix of ['point', 'line', 'fill']) {
        if (map.getLayer(`${sourceId}-${suffix}`)) {
          map.removeLayer(`${sourceId}-${suffix}`)
        }
      }
      if (map.getSource(sourceId)) map.removeSource(sourceId)
      vectorDataRef.current.delete(id)
    }
    vectorLayerIdsRef.current = active
  }, [vectorLayers, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const source = map.getSource('features') as GeoJSONSource | undefined
    source?.setData(featureData(features) as never)
  }, [features, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const draft = map.getSource('feature-draft') as GeoJSONSource | undefined
    draft?.setData(draftData(draftPoints, featureMode) as never)
    if (featureMode !== 'draw-line' && featureMode !== 'draw-polygon') {
      const preview = map.getSource('feature-preview') as
        | GeoJSONSource
        | undefined
      preview?.setData(EMPTY_SELECTION)
    }
  }, [draftPoints, featureMode, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const selected =
      featureMode === 'edit'
        ? features.find((feature) => feature.id === selectedFeatureId)
        : undefined
    const source = map.getSource('feature-vertices') as
      | GeoJSONSource
      | undefined
    source?.setData(vertexData(selected) as never)
    if (map.getLayer('feature-vertices')) {
      map.setLayoutProperty(
        'feature-vertices',
        'visibility',
        selected ? 'visible' : 'none',
      )
    }
  }, [features, featureMode, selectedFeatureId, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const data = vectorEditData(
      vectorLayers,
      featureMode === 'edit' ? selectedVector : null,
    )
    const outline = map.getSource('vector-edit') as GeoJSONSource | undefined
    outline?.setData(data.outline as never)
    const vertices = map.getSource('vector-vertices-edit') as
      | GeoJSONSource
      | undefined
    vertices?.setData(data.vertices as never)
    for (const id of ['vector-vertices-edit', 'vector-midpoints-edit']) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(
          id,
          'visibility',
          data.vertices.features.length > 0 ? 'visible' : 'none',
        )
      }
    }
    if (map.getLayer('vector-edit-outline')) {
      map.setLayoutProperty(
        'vector-edit-outline',
        'visibility',
        data.outline.features.length > 0 ? 'visible' : 'none',
      )
    }
  }, [vectorLayers, selectedVector, featureMode, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    if (featureMode !== 'draw-line' && featureMode !== 'draw-polygon') return
    const canvas = map.getCanvas()
    canvas.style.cursor = 'crosshair'
    map.doubleClickZoom.disable()

    const onAdd = (event: MapMouseEvent) => {
      if ((event.originalEvent as MouseEvent).button !== 0) return
      const target: LonLat = [event.lngLat.lng, event.lngLat.lat]
      onAddDraftPoint(
        snapping ? snapToVectors(map, target).point : target,
      )
    }
    const onFinish = (event: MapMouseEvent) => {
      event.preventDefault()
      onFinishDraft()
    }

    let frame = 0
    let cursor: LonLat | null = null
    const flushPreview = () => {
      frame = 0
      const source = map.getSource('feature-preview') as
        | GeoJSONSource
        | undefined
      if (!source) return
      const points = draftPointsRef.current
      const last = points[points.length - 1]
      source.setData(
        (last && cursor
          ? {
              type: 'FeatureCollection',
              features: [
                {
                  type: 'Feature',
                  properties: {},
                  geometry: { type: 'LineString', coordinates: [last, cursor] },
                },
              ],
            }
          : EMPTY_SELECTION) as never,
      )
    }
    const onPreview = (event: MapMouseEvent) => {
      if (draftPointsRef.current.length === 0) {
        setSnapIndicator(map, null)
        return
      }
      const target: LonLat = [event.lngLat.lng, event.lngLat.lat]
      const snap = snapping
        ? snapToVectors(map, target)
        : { point: target, snapped: false }
      cursor = snap.point
      setSnapIndicator(map, snap.snapped ? snap.point : null)
      if (frame === 0) frame = requestAnimationFrame(flushPreview)
    }
    const onLeave = () => setSnapIndicator(map, null)

    map.on('click', onAdd)
    map.on('dblclick', onFinish)
    map.on('mousemove', onPreview)
    map.on('mouseout', onLeave)

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      map.off('click', onAdd)
      map.off('dblclick', onFinish)
      map.off('mousemove', onPreview)
      map.off('mouseout', onLeave)
      setSnapIndicator(map, null)
      map.doubleClickZoom.enable()
      canvas.style.cursor = ''
      const preview = map.getSource('feature-preview') as
        | GeoJSONSource
        | undefined
      preview?.setData(EMPTY_SELECTION)
    }
  }, [featureMode, ready, onAddDraftPoint, onFinishDraft, snapping])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || featureMode !== 'edit') return
    type Drag =
      | { kind: 'feature'; id: string; index: number }
      | {
          kind: 'vector'
          layerId: string
          featureIndex: number
          path: VertexPath
        }
    let drag: Drag | null = null
    let frame = 0
    let pending: LonLat | null = null

    const vectorLayerIds = () =>
      vectorLayers.flatMap((layer) => {
        const prefix = `vector-${layer.id}`
        return [`${prefix}-fill`, `${prefix}-line`, `${prefix}-point`].filter(
          (id) => Boolean(map.getLayer(id)),
        )
      })
    const vectorHit = (
      event: MapMouseEvent,
      layer: 'vector-vertices-edit' | 'vector-midpoints-edit',
    ) => {
      const hit = map.queryRenderedFeatures(event.point, {
        layers: [layer],
      })[0]
      if (!hit) return null
      const layerId = hit.properties?.layerId
      const featureIndex = Number(hit.properties?.featureIndex)
      const path = hit.properties?.path
      if (
        typeof layerId !== 'string' ||
        !Number.isInteger(featureIndex) ||
        !Array.isArray(path) ||
        !path.every((index) => Number.isInteger(index))
      ) {
        return null
      }
      return {
        layerId,
        featureIndex,
        path: path as VertexPath,
        coordinates: (hit.geometry as { coordinates?: Position } | null)
          ?.coordinates,
      }
    }

    const flushVertex = () => {
      frame = 0
      if (!drag || !pending) return
      if (drag.kind === 'feature') {
        onMoveFeatureVertex(drag.id, drag.index, pending)
      } else {
        onMoveVectorVertex(
          drag.layerId,
          drag.featureIndex,
          drag.path,
          pending,
        )
      }
    }

    const onClick = (event: MapMouseEvent) => {
      // Vertex and midpoint interactions are handled by drag/insert handlers.
      if (vectorHit(event, 'vector-vertices-edit')) return
      const midpoint = vectorHit(event, 'vector-midpoints-edit')
      if (midpoint?.coordinates) {
        onInsertVectorVertex(
          midpoint.layerId,
          midpoint.featureIndex,
          midpoint.path,
          [midpoint.coordinates[0], midpoint.coordinates[1]],
        )
        return
      }
      const hits = map.queryRenderedFeatures(event.point, {
        layers: ['feature-fill', 'feature-line'],
      })
      const id = hits[0]?.properties?.id
      if (typeof id === 'string') {
        onSelectFeature(id)
        onSelectVectorFeature(null)
        return
      }
      const imported = map.queryRenderedFeatures(event.point, {
        layers: vectorLayerIds(),
      })[0]
      const source = imported?.source
      const featureIndex = Number(imported?.properties?.__mappaIndex)
      if (
        typeof source === 'string' &&
        source.startsWith('vector-') &&
        Number.isInteger(featureIndex)
      ) {
        onSelectVectorFeature({
          layerId: source.slice('vector-'.length),
          featureIndex,
        })
        onSelectFeature(null)
        return
      }
      onSelectFeature(null)
      onSelectVectorFeature(null)
    }
    const onDown = (event: MapMouseEvent) => {
      const vector = vectorHit(event, 'vector-vertices-edit')
      if (vector) {
        drag = {
          kind: 'vector',
          layerId: vector.layerId,
          featureIndex: vector.featureIndex,
          path: vector.path,
        }
      } else {
        const hits = map.queryRenderedFeatures(event.point, {
          layers: ['feature-vertices'],
        })
        const hit = hits[0]
        const id = hit?.properties?.featureId
        const index = Number(hit?.properties?.index)
        if (typeof id !== 'string' || !Number.isInteger(index)) return
        drag = { kind: 'feature', id, index }
      }
      pending = null
      map.dragPan.disable()
      map.boxZoom.disable()
      map.getCanvas().style.cursor = 'grabbing'
      event.preventDefault()
    }
    const onMove = (event: MapMouseEvent) => {
      if (!drag) return
      pending = [event.lngLat.lng, event.lngLat.lat]
      if (frame === 0) frame = requestAnimationFrame(flushVertex)
    }
    const onUp = () => {
      if (!drag) return
      if (frame !== 0) cancelAnimationFrame(frame)
      flushVertex()
      drag = null
      pending = null
      map.dragPan.enable()
      map.boxZoom.enable()
      map.getCanvas().style.cursor = ''
    }
    const onContext = (event: MapMouseEvent) => {
      const vector = vectorHit(event, 'vector-vertices-edit')
      if (vector) {
        event.preventDefault()
        onDeleteVectorVertex(vector.layerId, vector.featureIndex, vector.path)
        return
      }
      const hits = map.queryRenderedFeatures(event.point, {
        layers: ['feature-vertices'],
      })
      const hit = hits[0]
      const id = hit?.properties?.featureId
      const index = Number(hit?.properties?.index)
      if (typeof id !== 'string' || !Number.isInteger(index)) return
      event.preventDefault()
      onDeleteFeatureVertex(id, index)
    }

    map.on('click', onClick)
    map.on('mousedown', onDown)
    map.on('mousemove', onMove)
    map.on('mouseup', onUp)
    map.on('contextmenu', onContext)
    // A drag can end outside the canvas; do not leave pan disabled.
    window.addEventListener('mouseup', onUp)

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      map.off('click', onClick)
      map.off('mousedown', onDown)
      map.off('mousemove', onMove)
      map.off('mouseup', onUp)
      map.off('contextmenu', onContext)
      window.removeEventListener('mouseup', onUp)
      map.dragPan.enable()
      map.boxZoom.enable()
      map.getCanvas().style.cursor = ''
    }
  }, [
    featureMode,
    ready,
    vectorLayers,
    onSelectFeature,
    onMoveFeatureVertex,
    onDeleteFeatureVertex,
    onSelectVectorFeature,
    onMoveVectorVertex,
    onInsertVectorVertex,
    onDeleteVectorVertex,
  ])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || !drawing) return
    const canvas = map.getCanvas()
    let start: [number, number] | null = null
    canvas.style.cursor = 'crosshair'
    map.dragPan.disable()
    map.boxZoom.disable()

    const onDown = (event: MapMouseEvent) => {
      if ((event.originalEvent as MouseEvent).button !== 0) return
      event.preventDefault()
      start = [event.lngLat.lng, event.lngLat.lat]
      selectionPolygonRef.current = null
      applySelection(map, rectBounds(start, start), null)
    }
    const onMove = (event: MapMouseEvent) => {
      if (!start) return
      applySelection(
        map,
        rectBounds(start, [event.lngLat.lng, event.lngLat.lat]),
        null,
      )
    }
    const onUp = (event: MapMouseEvent) => {
      if (!start) return
      const bounds = rectBounds(start, [
        event.lngLat.lng,
        event.lngLat.lat,
      ])
      start = null
      const [[west, south], [east, north]] = bounds
      if (east - west > 1e-6 && north - south > 1e-6) {
        selectionRef.current = bounds
        selectionPolygonRef.current = null
        onSelectionChange(bounds)
      } else {
        applySelection(map, selectionRef.current, null)
      }
      onDrawingChange(false)
    }
    // Releasing outside the canvas must not leave pan/zoom disabled.
    const onWindowUp = () => {
      if (!start) return
      start = null
      applySelection(
        map,
        selectionRef.current,
        selectionPolygonRef.current,
      )
      onDrawingChange(false)
    }

    map.on('mousedown', onDown)
    map.on('mousemove', onMove)
    map.on('mouseup', onUp)
    window.addEventListener('mouseup', onWindowUp)

    return () => {
      map.off('mousedown', onDown)
      map.off('mousemove', onMove)
      map.off('mouseup', onUp)
      window.removeEventListener('mouseup', onWindowUp)
      applySelection(
        map,
        selectionRef.current,
        selectionPolygonRef.current,
      )
      map.dragPan.enable()
      map.boxZoom.enable()
      canvas.style.cursor = ''
    }
  }, [drawing, ready, onDrawingChange, onSelectionChange])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const source = map.getSource('measure') as GeoJSONSource | undefined
    source?.setData(measureData(measurePoints, measureMode) as never)

    const addLabel = (
      position: LonLat,
      text: string,
      variant = '',
    ) => {
      const marker = new MapLibreMarker({
        element: measureLabel(text, variant),
        anchor: 'center',
      })
        .setLngLat(position)
        .addTo(map)
      measureLabelsRef.current.push(marker)
    }

    for (let index = 1; index < measurePoints.length; index += 1) {
      const start = measurePoints[index - 1]
      const end = measurePoints[index]
      addLabel(
        midpoint(start, end),
        `${formatDistance(distance(start, end))} · ${formatAzimuth(
          bearing(start, end),
        )}`,
      )
    }
    if (measureMode === 'line' && measurePoints.length >= 2) {
      addLabel(
        measurePoints[measurePoints.length - 1],
        `Σ ${formatDistance(pathLength(measurePoints))}`,
        'is-total',
      )
    }
    if (measureMode === 'area' && measurePoints.length >= 3) {
      const count = measurePoints.length
      const centroid: LonLat = [
        measurePoints.reduce((sum, point) => sum + point[0], 0) / count,
        measurePoints.reduce((sum, point) => sum + point[1], 0) / count,
      ]
      addLabel(
        centroid,
        `S ${formatArea(polygonArea(measurePoints))} · P ${formatDistance(
          polygonPerimeter(measurePoints),
        )}`,
        'is-area',
      )
    }

    return () => {
      for (const label of measureLabelsRef.current) label.remove()
      measureLabelsRef.current = []
    }
  }, [measurePoints, measureMode, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || !measureMode) return
    const canvas = map.getCanvas()
    canvas.style.cursor = 'crosshair'
    map.doubleClickZoom.disable()

    const setPreview = (data: object) => {
      const source = map.getSource('measure-preview') as
        | GeoJSONSource
        | undefined
      source?.setData(data as never)
    }
    const onClick = (event: MapMouseEvent) => {
      const target: LonLat = [event.lngLat.lng, event.lngLat.lat]
      onMeasurePoint(snapping ? snapToVectors(map, target).point : target)
    }
    const onMove = (event: MapMouseEvent) => {
      if (measurePoints.length === 0) return
      const last = measurePoints[measurePoints.length - 1]
      const target: LonLat = [event.lngLat.lng, event.lngLat.lat]
      const snap = snapping
        ? snapToVectors(map, target)
        : { point: target, snapped: false }
      setSnapIndicator(map, snap.snapped ? snap.point : null)
      setPreview({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [last, snap.point],
        },
      })
    }
    const onLeave = () => {
      setPreview(EMPTY_SELECTION)
      setSnapIndicator(map, null)
    }

    map.on('click', onClick)
    map.on('mousemove', onMove)
    map.on('mouseout', onLeave)
    return () => {
      map.off('click', onClick)
      map.off('mousemove', onMove)
      map.off('mouseout', onLeave)
      map.doubleClickZoom.enable()
      canvas.style.cursor = ''
      setPreview(EMPTY_SELECTION)
      setSnapIndicator(map, null)
    }
  }, [measureMode, measurePoints, ready, onMeasurePoint, snapping])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || !placingMarker) return
    const canvas = map.getCanvas()
    canvas.style.cursor = 'copy'
    const onClick = (event: MapMouseEvent) => {
      onPlaceMarker([event.lngLat.lng, event.lngLat.lat])
    }
    map.on('click', onClick)
    return () => {
      map.off('click', onClick)
      canvas.style.cursor = ''
    }
  }, [placingMarker, ready, onPlaceMarker])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const source = map.getSource('markers') as GeoJSONSource | undefined
    source?.setData({
      type: 'FeatureCollection',
      features: markers.map((marker) => ({
        type: 'Feature',
        properties: {
          id: marker.id,
          name: marker.name,
          ...(marker.color ? { 'marker-color': marker.color } : {}),
        },
        geometry: {
          type: 'Point',
          coordinates: [marker.lon, marker.lat],
        },
      })),
    } as never)

    const useHtml = markers.length <= HTML_MARKER_LIMIT
    if (map.getLayer('marker-points')) {
      map.setLayoutProperty(
        'marker-points',
        'visibility',
        useHtml ? 'none' : 'visible',
      )
    }
    // Markers must not swallow clicks while a drawing/measure tool is active.
    const toolActive =
      drawing || measureMode !== null || featureMode !== 'off' || placingMarker
    const previous = mapMarkersRef.current
    const next = new Map<
      string,
      { handle: MapLibreMarker; element: HTMLDivElement }
    >()

    if (useHtml) {
      for (const marker of markers) {
        const selected = marker.id === selectedMarkerId
        const existing = previous.get(marker.id)
        if (existing) {
          existing.element.classList.toggle('is-selected', selected)
          existing.element.title = marker.description
            ? `${marker.name}\n${marker.description}`
            : marker.name
          const label = existing.element.querySelector('.map-marker-label')
          if (label && label.textContent !== marker.name) {
            label.textContent = marker.name
          }
          applyMarkerStyle(existing.element, marker)
          existing.element.style.pointerEvents = toolActive ? 'none' : ''
          existing.handle.setLngLat([marker.lon, marker.lat])
          next.set(marker.id, existing)
          continue
        }
        const element = markerElement(marker, selected)
        if (toolActive) element.style.pointerEvents = 'none'
        element.addEventListener('click', (event) => {
          event.stopPropagation()
          onSelectMarker(marker.id)
        })
        const handle = new MapLibreMarker({
          element,
          anchor: 'bottom',
          draggable: true,
        })
          .setLngLat([marker.lon, marker.lat])
          .addTo(map)
        handle.on('dragend', () => {
          const position = handle.getLngLat()
          onMoveMarker(marker.id, [position.lng, position.lat])
        })
        next.set(marker.id, { handle, element })
      }
    }
    for (const [id, entry] of previous) {
      if (!next.has(id)) entry.handle.remove()
    }
    mapMarkersRef.current = next
  }, [
    drawing,
    featureMode,
    markers,
    measureMode,
    placingMarker,
    selectedMarkerId,
    ready,
    onMoveMarker,
    onSelectMarker,
  ])

  // Remove HTML markers only when the canvas unmounts; dependency-driven
  // re-renders now update the existing handles in place.
  useEffect(
    () => () => {
      for (const entry of mapMarkersRef.current.values()) {
        entry.handle.remove()
      }
      mapMarkersRef.current.clear()
    },
    [],
  )

  useEffect(() => {
    const map = mapRef.current
    if (
      !ready ||
      !map ||
      drawing ||
      measureMode ||
      placingMarker ||
      featureMode !== 'off' ||
      markers.length <= HTML_MARKER_LIMIT
    ) {
      return
    }
    const onClick = (event: MapMouseEvent) => {
      const features = map.queryRenderedFeatures(event.point, {
        layers: ['marker-points'],
      })
      const id = features[0]?.properties?.id
      if (typeof id === 'string') onSelectMarker(id)
    }
    map.on('click', onClick)
    return () => {
      map.off('click', onClick)
    }
  }, [
    drawing,
    featureMode,
    measureMode,
    markers.length,
    onSelectMarker,
    placingMarker,
    ready,
  ])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return

    const current = new Set<string>()
    let structuresChanged = false
    for (const source of customSources) {
      current.add(source.id)
      const sourceId = `custom-src-${source.id}`
      const layerId = `custom-layer-${source.id}`
      const layer = customLayers[source.id]
      // Rebuild the raster source when its URL or tiling changed; MapLibre
      // has no API to mutate a source in place.
      const signature = JSON.stringify([
        source.url,
        source.kind,
        source.tileSize,
        source.minZoom,
        source.maxZoom,
        source.attribution,
      ])
      if (
        map.getSource(sourceId) &&
        customConfigsRef.current.get(source.id) !== signature
      ) {
        if (map.getLayer(layerId)) map.removeLayer(layerId)
        map.removeSource(sourceId)
      }
      customConfigsRef.current.set(source.id, signature)
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, {
          type: 'raster',
          tiles: providerTiles(source.id, [source.url]),
          tileSize: source.tileSize,
          minzoom: source.minZoom,
          maxzoom: source.maxZoom,
          attribution: source.attribution,
        })
        structuresChanged = true
      }
      if (!map.getLayer(layerId)) {
        map.addLayer({
          id: layerId,
          type: 'raster',
          source: sourceId,
          paint: {
            'raster-opacity': layer?.opacity ?? 1,
            'raster-fade-duration': 0,
          },
        })
        structuresChanged = true
      }
      map.setLayoutProperty(
        layerId,
        'visibility',
        (layer?.visible ?? true) ? 'visible' : 'none',
      )
      map.setPaintProperty(layerId, 'raster-opacity', layer?.opacity ?? 1)
    }
    for (const id of customIdsRef.current) {
      if (current.has(id)) continue
      const layerId = `custom-layer-${id}`
      if (map.getLayer(layerId)) map.removeLayer(layerId)
      if (map.getSource(`custom-src-${id}`)) map.removeSource(`custom-src-${id}`)
      customConfigsRef.current.delete(id)
    }
    if (structuresChanged) raiseFeatureLayers(map)
    customIdsRef.current = current
  }, [customSources, customLayers, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return

    const current = new Set(packs.map((pack) => pack.id))
    let structuresChanged = false
    for (const id of packIdsRef.current) {
      if (current.has(id)) continue
      const layerId = `pack-layer-${id}`
      if (map.getLayer(layerId)) map.removeLayer(layerId)
      if (map.getSource(id)) map.removeSource(id)
    }

    for (const pack of packs) {
      const layerId = `pack-layer-${pack.id}`
      if (!map.getSource(pack.id)) {
        map.addSource(pack.id, {
          type: 'raster',
          tiles: [`mappa://pack/${pack.id}/{z}/{x}/{y}`],
          tileSize: 256,
          minzoom: pack.minZoom,
          maxzoom: pack.maxZoom,
          bounds: [pack.west, pack.south, pack.east, pack.north],
          ...(pack.attribution ? { attribution: pack.attribution } : {}),
        })
        map.addLayer({
          id: layerId,
          type: 'raster',
          source: pack.id,
          layout: { visibility: pack.visible ? 'visible' : 'none' },
          paint: {
            'raster-opacity': pack.opacity,
            'raster-fade-duration': 0,
          },
        })
        structuresChanged = true
      } else if (map.getLayer(layerId)) {
        map.setLayoutProperty(
          layerId,
          'visibility',
          pack.visible ? 'visible' : 'none',
        )
        map.setPaintProperty(layerId, 'raster-opacity', pack.opacity)
      }
    }
    // Packs are added on top of the style; keep overlays above them.
    if (structuresChanged) raiseFeatureLayers(map)
    packIdsRef.current = current
  }, [packs, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || !map.getLayer('background')) {
      return
    }
    map.setPaintProperty(
      'background',
      'background-color',
      theme === 'dark' ? '#0e1116' : '#f6f4ef',
    )
  }, [theme, ready])

  return <div
      ref={containerRef}
      className="map-root"
      role="region"
      aria-label={t('a11y.map')}
    />
}

export type { ProviderId }
