import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { create } from 'zustand'
import { tr } from './locale.ts'
import { isNative } from './native'
import { useAppStore } from './store'

export type JobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface DownloadJob {
  id: string
  name: string
  providerId: string
  west: number
  south: number
  east: number
  north: number
  minZoom: number
  maxZoom: number
  polygon?: [number, number][] | null
  status: JobStatus
  totalTiles: number
  doneTiles: number
  failedTiles: number
  bytes: number
  cursorTiles: number
  createdAt: number
  updatedAt: number
  error: string | null
  /** Measured in the UI while the job is running. */
  speedBytesPerSecond?: number
  /** Remaining seconds at the current rate, null when unknown. */
  etaSeconds?: number | null
}

export interface ExportReport {
  path: string
  tiles: number
  bytes: number
  missing: number
}

export type ExportPhase = 'scanning' | 'writing' | 'finalizing' | 'signing'

export interface ExportEvent {
  id: string
  kind: 'mbtiles' | 'pmtiles'
  phase: ExportPhase
  done: number
  total: number
  writtenTiles: number
  writtenBytes: number
  status: 'running' | 'done' | 'cancelled' | 'failed'
  path: string | null
  error: string | null
}

export interface ExportRecord extends ExportEvent {
  speedTilesPerSecond?: number
  etaSeconds?: number | null
}

export const exportKey = (id: string, kind: string) => `${id}:${kind}`

export interface NewDownloadRequest {
  name?: string
  providerId: string
  west: number
  south: number
  east: number
  north: number
  minZoom: number
  maxZoom: number
  polygon?: [number, number][]
  sourceIds?: string[]
}

export const MAX_JOB_TILES = 2_000_000

const statusOrder: Record<JobStatus, number> = {
  running: 0,
  paused: 1,
  queued: 2,
  completed: 3,
  cancelled: 4,
  failed: 5,
}

const rateSamples = new Map<
  string,
  { at: number; processed: number; bytes: number }
>()

const exportSamples = new Map<
  string,
  { at: number; processed: number; phase: ExportPhase }
>()

/** Rate and ETA within one export phase; scanning and writing are separate. */
const withExportRate = (event: ExportEvent): ExportRecord => {
  const key = `${exportKey(event.id, event.kind)}:${event.phase}`
  if (event.status !== 'running') {
    exportSamples.delete(key)
    return { ...event, speedTilesPerSecond: undefined, etaSeconds: null }
  }
  const now = Date.now()
  const previous = exportSamples.get(key)
  exportSamples.set(key, {
    at: now,
    processed: event.done,
    phase: event.phase,
  })
  if (!previous) {
    return { ...event, speedTilesPerSecond: undefined, etaSeconds: null }
  }
  const seconds = (now - previous.at) / 1000
  if (seconds < 0.15) return event
  const speed = Math.max(0, (event.done - previous.processed) / seconds)
  const remaining = Math.max(0, event.total - event.done)
  return {
    ...event,
    speedTilesPerSecond: speed,
    etaSeconds: speed > 0.01 ? remaining / speed : null,
  }
}

/** Adds a short-window rate and ETA without persisting either in SQLite. */
const withRate = (job: DownloadJob): DownloadJob => {
  if (job.status !== 'running') {
    rateSamples.delete(job.id)
    return { ...job, speedBytesPerSecond: undefined, etaSeconds: null }
  }
  const now = Date.now()
  const processed = job.doneTiles + job.failedTiles
  const previous = rateSamples.get(job.id)
  rateSamples.set(job.id, { at: now, processed, bytes: job.bytes })
  if (!previous) {
    return { ...job, speedBytesPerSecond: undefined, etaSeconds: null }
  }
  const seconds = (now - previous.at) / 1000
  if (seconds < 0.15) {
    return {
      ...job,
      speedBytesPerSecond: job.speedBytesPerSecond,
      etaSeconds: job.etaSeconds ?? null,
    }
  }
  const bytesPerSecond = Math.max(0, (job.bytes - previous.bytes) / seconds)
  const tilesPerSecond = Math.max(0, (processed - previous.processed) / seconds)
  const remaining = Math.max(0, job.totalTiles - processed)
  return {
    ...job,
    speedBytesPerSecond: bytesPerSecond,
    etaSeconds:
      tilesPerSecond > 0.01 ? remaining / tilesPerSecond : null,
  }
}

const sortJobs = (jobs: DownloadJob[]) =>
  [...jobs].sort(
    (left, right) =>
      statusOrder[left.status] - statusOrder[right.status] ||
      right.createdAt - left.createdAt,
  )

interface DownloadsState {
  jobs: DownloadJob[]
  exports: Record<string, ExportRecord>
  loaded: boolean
  loading: boolean
  error: string | null
  init: () => Promise<void>
  refresh: () => Promise<void>
  create: (request: NewDownloadRequest) => Promise<DownloadJob>
  pause: (id: string) => Promise<void>
  resume: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  clearFinished: () => Promise<void>
  exportJob: (
    id: string,
    kind: 'mbtiles' | 'pmtiles',
    license?: string,
  ) => Promise<ExportReport>
  cancelExport: (id: string, kind: 'mbtiles' | 'pmtiles') => Promise<void>
}

let eventsReady: Promise<void> | null = null
/// Deletions seen in this session. A `list_downloads` snapshot taken just
/// before a removal must not resurrect the job when it lands afterwards.
const removedIds = new Set<string>()

const ensureEvents = () => {
  if (!isNative) return Promise.resolve()
  eventsReady ??= (async () => {
    await listen<DownloadJob>('downloads://job', (event) => {
      if (removedIds.has(event.payload.id)) return
      const previous = useDownloadsStore
        .getState()
        .jobs.find((job) => job.id === event.payload.id)
      if (previous && previous.status !== event.payload.status) {
        if (event.payload.status === 'completed') {
          useAppStore
            .getState()
            .showToast(
              tr(
                'Загрузка завершена: {p0} · {p1}/{p2}',
                'Download complete: {p0} · {p1}/{p2}',
                { p0: event.payload.name, p1: event.payload.doneTiles, p2: event.payload.totalTiles },
              ),
            )
        } else if (event.payload.status === 'failed') {
          useAppStore
            .getState()
            .showToast(
              tr(
                'Загрузка не удалась: {p0}{p1}',
                'Download failed: {p0}{p1}',
                { p0: event.payload.name, p1: event.payload.error ? ` · ${event.payload.error}` : '' },
              ),
            )
        }
      }
      const measured = withRate(event.payload)
      useDownloadsStore.setState((state) => ({
        jobs: sortJobs([
          measured,
          ...state.jobs.filter((job) => job.id !== event.payload.id),
        ]),
        loaded: true,
      }))
    })
    await listen<string>('downloads://removed', (event) => {
      removedIds.add(event.payload)
      useDownloadsStore.setState((state) => ({
        jobs: state.jobs.filter((job) => job.id !== event.payload),
      }))
    })
    await listen<ExportEvent>('packs://export', (event) => {
      const key = exportKey(event.payload.id, event.payload.kind)
      useDownloadsStore.setState((state) => ({
        exports: {
          ...state.exports,
          [key]: withExportRate(event.payload),
        },
      }))
    })
  })()
  return eventsReady
}

const call = async <T>(command: string, args?: Record<string, unknown>) => {
  if (!isNative) {
    throw new Error(
      tr(
        'Доступно только в нативном приложении',
        'Available only in the native app',
      ),
    )
  }
  return invoke<T>(command, args)
}

export const useDownloadsStore = create<DownloadsState>((set, get) => ({
  jobs: [],
  exports: {},
  loaded: false,
  loading: false,
  error: null,

  init: async () => {
    try {
      await ensureEvents()
      if (!get().loaded) await get().refresh()
    } catch (error) {
      set({ error: String(error), loaded: true, loading: false })
    }
  },

  refresh: async () => {
    if (!isNative) {
      set({ loaded: true, loading: false })
      return
    }
    set({ loading: true, error: null })
    try {
      const jobs = await call<DownloadJob[]>('list_downloads')
      set((state) => {
        // Events may have arrived while the snapshot was in flight; never
        // let an older snapshot roll progress backwards.
        const merged = new Map(
          jobs
            .filter((job) => !removedIds.has(job.id))
            .map((job) => [job.id, job]),
        )
        for (const current of state.jobs) {
          if (removedIds.has(current.id)) continue
          const known = merged.get(current.id)
          if (!known || current.updatedAt > known.updatedAt) {
            merged.set(current.id, current)
          }
        }
        return {
          jobs: sortJobs([...merged.values()]),
          loaded: true,
          loading: false,
        }
      })
    } catch (error) {
      set({ error: String(error), loaded: true, loading: false })
    }
  },

  create: async (request) => {
    const job = await call<DownloadJob>('create_download', { request })
    removedIds.delete(job.id)
    set((state) => ({
      jobs: sortJobs([
        job,
        ...state.jobs.filter((item) => item.id !== job.id),
      ]),
      loaded: true,
      error: null,
    }))
    return job
  },

  pause: async (id) => {
    await call('pause_download', { id })
  },

  resume: async (id) => {
    await call('resume_download', { id })
  },

  cancel: async (id) => {
    await call('cancel_download', { id })
  },

  remove: async (id) => {
    await call('delete_download', { id })
    set((state) => ({ jobs: state.jobs.filter((job) => job.id !== id) }))
  },

  clearFinished: async () => {
    await call('clear_finished_downloads')
    set((state) => ({
      jobs: state.jobs.filter(
        (job) => job.status !== 'completed' && job.status !== 'cancelled',
      ),
    }))
  },

  exportJob: async (id, kind, license) => {
    const key = exportKey(id, kind)
    set((state) => ({
      exports: {
        ...state.exports,
        [key]: {
          id,
          kind,
          phase: 'scanning',
          done: 0,
          total: 0,
          writtenTiles: 0,
          writtenBytes: 0,
          status: 'running',
          path: null,
          error: null,
        },
      },
    }))
    try {
      return await call<ExportReport>('export_job_pack', {
        id,
        kind,
        license: license ?? null,
      })
    } catch (error) {
      set((state) => {
        const current = state.exports[key]
        if (current && current.status !== 'running') return state
        return {
          exports: {
            ...state.exports,
            [key]: {
              id,
              kind,
              phase: current?.phase ?? 'writing',
              done: current?.done ?? 0,
              total: current?.total ?? 0,
              writtenTiles: current?.writtenTiles ?? 0,
              writtenBytes: current?.writtenBytes ?? 0,
              status: 'failed',
              path: null,
              error: String(error),
            },
          },
        }
      })
      throw error
    }
  },

  cancelExport: async (id, kind) => {
    await call('cancel_export_pack', { id, kind })
  },
}))
