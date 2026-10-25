/**
 * Offline routing over line data already loaded in Mappa.
 *
 * Imported roads/tracks and user-drawn lines become a graph. Vertices closer
 * than the snap tolerance share a node, and A* finds the shortest path. No
 * external routing service or road-data format is required.
 */

import { invoke } from '@tauri-apps/api/core'
import type { Geometry, Position } from 'geojson'
import {
  bearing,
  circlePolygon,
  destination,
  distance,
  type LonLat,
} from './geo.ts'
import { isNative } from './native.ts'
import type { MapFeature } from './features.ts'
import type { VectorLayer } from './vectorLayers.ts'

export const MAX_ROUTE_NODES = 200_000
export const MAX_ROUTE_EDGES = 500_000
export const MAX_ROUTE_SNAP = 250
export const DEFAULT_ROUTE_TOLERANCE = 12

export type RouteErrorCode =
  | 'no-lines'
  | 'too-large'
  | 'start-snap'
  | 'end-snap'
  | 'no-path'

export class RouteError extends Error {
  readonly code: RouteErrorCode

  constructor(code: RouteErrorCode, message: string) {
    super(message)
    this.name = 'RouteError'
    this.code = code
  }
}

export interface RouteGraphStats {
  lines: number
  nodes: number
  edges: number
}

export interface RouteResult {
  coordinates: LonLat[]
  distance: number
  snappedStart: LonLat
  snappedEnd: LonLat
  startOffset: number
  endOffset: number
  stats: RouteGraphStats
}

export type RoutingEngine = 'offline' | 'osrm' | 'brouter'

/** One OSRM-style maneuver. Offline routes derive the same shape. */
export interface RouteStep {
  /** `depart`, `turn`, `arrive`, `roundabout`, … */
  maneuver: string
  /** `left`, `right`, `slight left`, `uturn`, empty for depart/arrive. */
  modifier: string
  /** Road name when known. */
  name: string
  /** Metres until the next maneuver. */
  distance: number
  /** Seconds until the next maneuver. */
  duration: number
  location: LonLat
}

export interface RoutePlan extends RouteResult {
  /** Total duration in seconds; estimated offline from the profile speed. */
  duration: number
  steps: RouteStep[]
  engine: RoutingEngine
}

export interface IsochroneResult {
  coordinates: LonLat[]
  distance: number
  duration: number
  reachableNodes: number
}

interface RemoteStep {
  kind: string
  modifier: string
  name: string
  distance: number
  duration: number
  location: [number, number]
}

interface RemoteRoute {
  engine: RoutingEngine
  coordinates: LonLat[]
  distance: number
  duration: number
  steps: RemoteStep[]
}

interface RouteGraph {
  nodes: LonLat[]
  adjacency: Edge[][]
  edges: number
}

interface RouteSources {
  features: MapFeature[]
  vectorLayers: VectorLayer[]
  useFeatures: boolean
  useVectors: boolean
}

interface Edge {
  to: number
  weight: number
}

const validPoint = (value: unknown): LonLat | null => {
  if (!Array.isArray(value) || value.length < 2) return null
  const lon = Number(value[0])
  const lat = Number(value[1])
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null
  return [lon, lat]
}

const cleanLine = (points: unknown[]): LonLat[] => {
  const result: LonLat[] = []
  for (const value of points) {
    const point = validPoint(value)
    if (!point) continue
    const last = result[result.length - 1]
    if (last && last[0] === point[0] && last[1] === point[1]) continue
    result.push(point)
  }
  return result.length >= 2 ? result : []
}

const geometryLines = (geometry: Geometry): LonLat[][] => {
  switch (geometry.type) {
    case 'LineString':
      return [cleanLine(geometry.coordinates as Position[])].filter(
        (line) => line.length >= 2,
      )
    case 'MultiLineString':
      return geometry.coordinates
        .map((line) => cleanLine(line as Position[]))
        .filter((line) => line.length >= 2)
    default:
      return []
  }
}

/** Collects routable lines from drawn features and imported vector layers. */
export function routeLines(sources: RouteSources): LonLat[][] {
  const lines: LonLat[][] = []
  if (sources.useFeatures) {
    for (const feature of sources.features) {
      if (feature.kind !== 'line') continue
      const line = cleanLine(feature.coordinates)
      if (line.length >= 2) lines.push(line)
    }
  }
  if (sources.useVectors) {
    for (const layer of sources.vectorLayers) {
      for (const feature of layer.features) {
        lines.push(...geometryLines(feature.geometry))
      }
    }
  }
  return lines
}

class MinHeap {
  private readonly nodes: number[] = []
  private readonly priorities: number[] = []

  get size(): number {
    return this.nodes.length
  }

  push(node: number, priority: number): void {
    let index = this.nodes.length
    this.nodes.push(node)
    this.priorities.push(priority)
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (this.priorities[parent] <= priority) break
      this.nodes[index] = this.nodes[parent]
      this.priorities[index] = this.priorities[parent]
      index = parent
    }
    this.nodes[index] = node
    this.priorities[index] = priority
  }

  pop(): { node: number; priority: number } | null {
    if (this.nodes.length === 0) return null
    const node = this.nodes[0]
    const priority = this.priorities[0]
    const lastNode = this.nodes.pop() as number
    const lastPriority = this.priorities.pop() as number
    if (this.nodes.length > 0) {
      let index = 0
      const length = this.nodes.length
      while (true) {
        const left = index * 2 + 1
        if (left >= length) break
        const right = left + 1
        const child =
          right < length && this.priorities[right] < this.priorities[left]
            ? right
            : left
        if (this.priorities[child] >= lastPriority) break
        this.nodes[index] = this.nodes[child]
        this.priorities[index] = this.priorities[child]
        index = child
      }
      this.nodes[index] = lastNode
      this.priorities[index] = lastPriority
    }
    return { node, priority }
  }
}

const nearestNode = (
  nodes: LonLat[],
  point: LonLat,
  limit: number,
): { index: number; offset: number } | null => {
  let best = -1
  let offset = Number.POSITIVE_INFINITY
  for (let index = 0; index < nodes.length; index += 1) {
    const candidate = distance(nodes[index], point)
    if (candidate < offset) {
      best = index
      offset = candidate
    }
  }
  return best >= 0 && offset <= limit ? { index: best, offset } : null
}

/** Builds the shared vertex graph used by routes and isochrones. */
function buildGraph(
  lines: LonLat[][],
  start: LonLat,
  end: LonLat,
  tolerance: number,
): RouteGraph {
  if (lines.length === 0) {
    throw new RouteError(
      'no-lines',
      'No routable line features or vector layers are selected',
    )
  }
  const snap = Math.max(0.5, Math.min(100, tolerance))
  const cell = snap / 111_320
  const cosRef = Math.max(
    0.01,
    Math.cos((((start[1] + end[1]) / 2) * Math.PI) / 180),
  )
  const nodes: LonLat[] = []
  const adjacency: Edge[][] = []
  const grid = new Map<string, number[]>()
  let edges = 0

  const cellKey = (point: LonLat): [number, number] => [
    Math.floor((point[0] * cosRef) / cell),
    Math.floor(point[1] / cell),
  ]

  const addNode = (point: LonLat): number => {
    if (nodes.length >= MAX_ROUTE_NODES) {
      throw new RouteError(
        'too-large',
        `Route graph exceeds ${MAX_ROUTE_NODES} nodes`,
      )
    }
    const index = nodes.length
    nodes.push(point)
    adjacency.push([])
    const [gx, gy] = cellKey(point)
    const key = `${gx}:${gy}`
    const bucket = grid.get(key)
    if (bucket) bucket.push(index)
    else grid.set(key, [index])
    return index
  }

  const findNode = (point: LonLat): number => {
    const [gx, gy] = cellKey(point)
    let best = -1
    let bestDistance = snap
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = grid.get(`${gx + dx}:${gy + dy}`)
        if (!bucket) continue
        for (const index of bucket) {
          const candidate = distance(nodes[index], point)
          if (candidate < bestDistance) {
            best = index
            bestDistance = candidate
          }
        }
      }
    }
    return best
  }

  for (const line of lines) {
    let previous = -1
    for (const point of line) {
      let node = findNode(point)
      if (node < 0) node = addNode(point)
      if (previous >= 0 && previous !== node) {
        const weight = distance(nodes[previous], nodes[node])
        if (weight > 0) {
          if (edges >= MAX_ROUTE_EDGES) {
            throw new RouteError(
              'too-large',
              `Route graph exceeds ${MAX_ROUTE_EDGES} edges`,
            )
          }
          adjacency[previous].push({ to: node, weight })
          adjacency[node].push({ to: previous, weight })
          edges += 1
        }
      }
      previous = node
    }
  }
  return { nodes, adjacency, edges }
}

/**
 * Builds a graph from `lines` and routes between the nearest vertices.
 * Start/end are not connected to the network with artificial edges; the
 * returned offsets tell how far they were snapped.
 */
export function buildRoute(
  lines: LonLat[][],
  start: LonLat,
  end: LonLat,
  tolerance = DEFAULT_ROUTE_TOLERANCE,
): RouteResult {
  const { nodes, adjacency, edges } = buildGraph(lines, start, end, tolerance)
  const startSnap = nearestNode(nodes, start, MAX_ROUTE_SNAP)
  if (!startSnap) {
    throw new RouteError(
      'start-snap',
      `Start is farther than ${MAX_ROUTE_SNAP} m from the line network`,
    )
  }
  const endSnap = nearestNode(nodes, end, MAX_ROUTE_SNAP)
  if (!endSnap) {
    throw new RouteError(
      'end-snap',
      `Finish is farther than ${MAX_ROUTE_SNAP} m from the line network`,
    )
  }

  const startIndex = startSnap.index
  const endIndex = endSnap.index
  const coordinates: LonLat[] = []
  let routeDistance = 0
  if (startIndex === endIndex) {
    coordinates.push(nodes[startIndex])
  } else {
    const size = nodes.length
    const best = new Float64Array(size).fill(Number.POSITIVE_INFINITY)
    const previous = new Int32Array(size).fill(-1)
    const closed = new Uint8Array(size)
    const heap = new MinHeap()
    best[startIndex] = 0
    heap.push(startIndex, distance(nodes[startIndex], nodes[endIndex]))
    while (heap.size > 0) {
      const entry = heap.pop()
      if (!entry || closed[entry.node]) continue
      closed[entry.node] = 1
      if (entry.node === endIndex) break
      for (const edge of adjacency[entry.node]) {
        const candidate = best[entry.node] + edge.weight
        if (candidate >= best[edge.to]) continue
        best[edge.to] = candidate
        previous[edge.to] = entry.node
        heap.push(
          edge.to,
          candidate + distance(nodes[edge.to], nodes[endIndex]),
        )
      }
    }
    if (!closed[endIndex]) {
      throw new RouteError('no-path', 'No route connects the selected points')
    }
    routeDistance = best[endIndex]
    let current = endIndex
    while (current >= 0) {
      coordinates.push(nodes[current])
      if (current === startIndex) break
      current = previous[current]
    }
    if (coordinates[coordinates.length - 1] !== nodes[startIndex]) {
      throw new RouteError('no-path', 'No route connects the selected points')
    }
    coordinates.reverse()
  }

  return {
    coordinates,
    distance: routeDistance,
    snappedStart: nodes[startIndex],
    snappedEnd: nodes[endIndex],
    startOffset: startSnap.offset,
    endOffset: endSnap.offset,
    stats: { lines: lines.length, nodes: nodes.length, edges },
  }
}

/** Shortest distance in metres from a point to a polyline. */
export function distanceToRoute(point: LonLat, coordinates: LonLat[]): number {
  if (coordinates.length === 0) return Number.POSITIVE_INFINITY
  if (coordinates.length === 1) return distance(point, coordinates[0])
  const metresPerDegree = 111_320
  const kx = metresPerDegree * Math.cos((point[1] * Math.PI) / 180)
  const ky = metresPerDegree
  const project = (value: LonLat): [number, number] => [
    (value[0] - point[0]) * kx,
    (value[1] - point[1]) * ky,
  ]
  let nearest = Number.POSITIVE_INFINITY
  let [ax, ay] = project(coordinates[0])
  for (let index = 1; index < coordinates.length; index += 1) {
    const [bx, by] = project(coordinates[index])
    const dx = bx - ax
    const dy = by - ay
    const lengthSquared = dx * dx + dy * dy
    const t =
      lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared))
    nearest = Math.min(
      nearest,
      Math.hypot(ax + t * dx, ay + t * dy),
    )
    ax = bx
    ay = by
  }
  return nearest
}

/** Derives simple maneuvers from geometry when the router returns none. */
export function buildSteps(
  coordinates: LonLat[],
  distanceMeters: number,
  durationSeconds: number,
): RouteStep[] {
  if (coordinates.length < 2) return []
  const speed =
    durationSeconds > 0 && distanceMeters > 0
      ? distanceMeters / durationSeconds
      : 0
  const steps: RouteStep[] = [
    {
      maneuver: 'depart',
      modifier: '',
      name: '',
      distance: 0,
      duration: 0,
      location: coordinates[0],
    },
  ]
  let sinceTurn = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    sinceTurn += distance(coordinates[index - 1], coordinates[index])
    if (index === coordinates.length - 1) break
    const incoming = bearing(coordinates[index - 1], coordinates[index])
    const outgoing = bearing(coordinates[index], coordinates[index + 1])
    let delta = ((outgoing - incoming + 540) % 360) - 180
    if (Math.abs(delta) < 18) continue
    const modifier =
      Math.abs(delta) >= 160
        ? 'uturn'
        : Math.abs(delta) >= 120
          ? delta > 0
            ? 'sharp right'
            : 'sharp left'
          : Math.abs(delta) >= 45
            ? delta > 0
              ? 'right'
              : 'left'
            : delta > 0
              ? 'slight right'
              : 'slight left'
    steps.push({
      maneuver: 'turn',
      modifier,
      name: '',
      distance: sinceTurn,
      duration: speed > 0 ? sinceTurn / speed : 0,
      location: coordinates[index],
    })
    sinceTurn = 0
  }
  steps.push({
    maneuver: 'arrive',
    modifier: '',
    name: '',
    distance: sinceTurn,
    duration: speed > 0 ? sinceTurn / speed : 0,
    location: coordinates[coordinates.length - 1],
  })
  return steps
}

/** Calls the configured OSRM/BRouter server through the Rust proxy client. */
export async function remoteRoute(
  engine: RoutingEngine,
  url: string,
  profile: string,
  start: LonLat,
  end: LonLat,
): Promise<RoutePlan> {
  if (!isNative) {
    throw new Error('remote routing is available only in the native app')
  }
  const response = await invoke<RemoteRoute>('route_remote', {
    engine,
    url: url.trim() || null,
    profile,
    start,
    end,
  })
  if (response.coordinates.length < 2) {
    throw new Error('routing server returned an empty geometry')
  }
  const steps =
    response.steps.length > 0
      ? response.steps.map((step) => ({
          maneuver: step.kind,
          modifier: step.modifier,
          name: step.name,
          distance: step.distance,
          duration: step.duration,
          location: step.location as LonLat,
        }))
      : buildSteps(response.coordinates, response.distance, response.duration)
  return {
    coordinates: response.coordinates,
    distance: response.distance,
    duration: response.duration,
    steps,
    engine: response.engine,
    snappedStart: response.coordinates[0],
    snappedEnd: response.coordinates[response.coordinates.length - 1],
    startOffset: 0,
    endOffset: 0,
    stats: {
      lines: 0,
      nodes: response.coordinates.length,
      edges: response.coordinates.length - 1,
    },
  }
}

/** Convex hull of reachable graph vertices, used as the isochrone outline. */
const convexHull = (points: LonLat[]): LonLat[] => {
  if (points.length <= 3) return points
  const cos = Math.cos((points[0][1] * Math.PI) / 180)
  const projected = points
    .map((point) => [point[0] * cos, point[1], point] as const)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const cross = (
    a: readonly [number, number, LonLat],
    b: readonly [number, number, LonLat],
    c: readonly [number, number, LonLat],
  ) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const lower: (readonly [number, number, LonLat])[] = []
  for (const point of projected) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
    ) {
      lower.pop()
    }
    lower.push(point)
  }
  const upper: (readonly [number, number, LonLat])[] = []
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    const point = projected[index]
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
    ) {
      upper.pop()
    }
    upper.push(point)
  }
  lower.pop()
  upper.pop()
  return [...lower, ...upper].map((entry) => entry[2])
}

/**
 * Builds a time-reachability polygon over the selected line network.
 * `speedKmh` is a crude profile speed because the offline graph has no tags.
 */
export function buildIsochrone(
  lines: LonLat[][],
  start: LonLat,
  minutes: number,
  speedKmh: number,
  tolerance = DEFAULT_ROUTE_TOLERANCE,
): IsochroneResult {
  const duration = Math.max(1, Math.min(600, minutes)) * 60
  const speed = Math.max(1, Math.min(200, speedKmh))
  const maxDistance = (duration * speed) / 3.6
  const { nodes, adjacency } = buildGraph(lines, start, start, tolerance)
  const startSnap = nearestNode(nodes, start, MAX_ROUTE_SNAP)
  if (!startSnap) {
    throw new RouteError(
      'start-snap',
      `Start is farther than ${MAX_ROUTE_SNAP} m from the line network`,
    )
  }
  const best = new Float64Array(nodes.length).fill(Number.POSITIVE_INFINITY)
  best[startSnap.index] = 0
  const heap = new MinHeap()
  heap.push(startSnap.index, 0)
  while (heap.size > 0) {
    const entry = heap.pop()
    if (!entry || entry.priority > maxDistance) break
    if (entry.priority > best[entry.node]) continue
    for (const edge of adjacency[entry.node]) {
      const candidate = best[entry.node] + edge.weight
      if (candidate <= maxDistance && candidate < best[edge.to]) {
        best[edge.to] = candidate
        heap.push(edge.to, candidate)
      }
    }
  }
  const reachable = nodes.filter((_, index) => best[index] <= maxDistance)
  let coordinates =
    reachable.length >= 3
      ? convexHull(reachable)
      : circlePolygon(start, destination(start, 0, maxDistance))
  if (coordinates.length < 3) {
    coordinates = circlePolygon(start, destination(start, 0, maxDistance))
  }
  if (coordinates.length >= 3) coordinates.push(coordinates[0])
  return {
    coordinates,
    distance: maxDistance,
    duration,
    reachableNodes: reachable.length,
  }
}

/** Buffers a polyline into a closed polygon for route-scoped downloads. */
export function routeCorridor(
  coordinates: LonLat[],
  halfWidthMeters: number,
): LonLat[] {
  if (coordinates.length < 2) return []
  const width = Math.max(20, Math.min(5000, halfWidthMeters))
  const left: LonLat[] = []
  const right: LonLat[] = []
  for (let index = 0; index < coordinates.length; index += 1) {
    const previous = coordinates[Math.max(0, index - 1)]
    const next = coordinates[Math.min(coordinates.length - 1, index + 1)]
    const azimuth = bearing(previous, next)
    left.push(destination(coordinates[index], (azimuth - 90 + 360) % 360, width))
    right.push(destination(coordinates[index], (azimuth + 90) % 360, width))
  }
  return [...left, ...right.reverse(), left[0]]
}
