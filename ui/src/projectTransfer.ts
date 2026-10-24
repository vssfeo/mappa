/** Native dialogs and workspace swapping for `.mappa` projects. */

import { open, save } from '@tauri-apps/plugin-dialog'
import type { Map as MapLibreMap } from 'maplibre-gl'
import {
  autosavePath,
  isNative,
  readTextFile,
  writeTextFile,
} from './native'
import { closePack, openPackPath } from './packs'
import { serialize } from './serial'
import {
  buildProject,
  defaultProject,
  parseProject,
  serializeProject,
  type MappaProject,
} from './projectFile'
import type { MapFeature } from './features'
import { useAppStore } from './store'
import { useViewStore } from './viewStore'
import { tr } from './locale.ts'

const requireNative = () => {
  if (!isNative) {
    throw new Error(tr('Проекты доступны в нативном приложении', 'Projects are available in the native app'))
  }
}

const withoutControls = (value: string): string =>
  Array.from(value, (character) =>
    character.charCodeAt(0) < 32 ? '-' : character,
  ).join('')

const fileName = (name: string): string => {
  const safe = withoutControls(name.replace(/[\\/:*?"<>|]/g, '-'))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `${safe || 'mappa-project'}.mappa`
}

const snapshot = (name: string) => {
  const state = useAppStore.getState()
  const mapView = useViewStore.getState().mapView
  return buildProject({
    name,
    providerId: state.providerId,
    providerOrder: state.providerOrder,
    view: {
      center: mapView.center,
      zoom: mapView.zoom,
    },
    layers: state.layers,
    customLayers: state.customLayers,
    packPaths: state.packPaths,
    markers: state.markers,
    features: state.features,
    vectorLayers: state.vectorLayers,
    coordinateFormat: state.coordinateFormat,
    crs: state.crs,
    crsLabel: state.crsLabel,
  })
}

let cachedAutosavePath: string | null = null

const recoveryPath = async (): Promise<string> => {
  cachedAutosavePath ??= await autosavePath()
  return cachedAutosavePath
}

/**
 * Writes the workspace to the recovery slot. Called by the idle autosave loop
 * and by the Projects panel; it never touches the user's project file.
 */
export async function autosaveProject(): Promise<string | null> {
  if (!isNative) return null
  const state = useAppStore.getState()
  if (!state.autosaveEnabled) return null
  if (
    !state.projectPath &&
    state.markers.length === 0 &&
    state.features.length === 0 &&
    state.vectorLayers.length === 0
  ) {
    return null
  }
  const path = await recoveryPath()
  await writeTextFile(path, serializeProject(snapshot(state.projectName)))
  return path
}

export interface AutosaveSnapshot {
  project: MappaProject
  features: MapFeature[]
  path: string
}

/** Reads the recovery slot, or null when it is absent or corrupt. */
export async function readAutosave(): Promise<AutosaveSnapshot | null> {
  if (!isNative) return null
  try {
    const path = await recoveryPath()
    const parsed = parseProject(await readTextFile(path))
    return { project: parsed.file, features: parsed.features, path }
  } catch {
    return null
  }
}

/** Applies the recovery slot without adopting it as the project path. */
export async function restoreAutosave(
  map: MapLibreMap | null,
): Promise<boolean> {
  const slot = await readAutosave()
  if (!slot) return false
  await applyProject(slot.project, slot.features, null, map)
  return true
}

/**
 * Saves the recovery slot after 12 s without edits. Repeated edits coalesce,
 * so dragging a vertex does not write the project on every frame.
 */
export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void autosaveProject().catch((error: unknown) =>
        console.warn('autosave failed', error),
      )
    }, 12_000)
  }
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (
      state.markers !== previous.markers ||
      state.features !== previous.features ||
      state.vectorLayers !== previous.vectorLayers ||
      state.projectName !== previous.projectName ||
      state.autosaveEnabled !== previous.autosaveEnabled
    ) {
      schedule()
    }
  })
  return () => {
    if (timer !== null) clearTimeout(timer)
    unsubscribe()
  }
}

export interface ProjectSaveResult {
  name: string
  path: string
}

/** Saves to the current path or asks for a new one. */
export async function saveProjectFile(options?: {
  saveAs?: boolean
  name?: string
}): Promise<ProjectSaveResult | null> {
  requireNative()
  return serialize(async () => {
    const state = useAppStore.getState()
    const name =
      (options?.name ?? state.projectName).trim() ||
      tr('Мой проект', 'My project')
    let path = options?.saveAs ? null : state.projectPath
    if (!path) {
      const selected = await save({
        title: tr('Сохранить проект', 'Save project'),
        defaultPath: fileName(name),
        filters: [
          { name: tr('Проект Mappa', 'Mappa project'), extensions: ['mappa'] },
        ],
      })
      if (typeof selected !== 'string' || selected.length === 0) return null
      path = selected.toLowerCase().endsWith('.mappa')
        ? selected
        : `${selected}.mappa`
    }
    const project = snapshot(name)
    await writeTextFile(path, serializeProject(project))
    state.setProjectMeta(project.name, path)
    state.addRecentProject({
      name: project.name,
      path,
      at: Date.now(),
    })
    return { name: project.name, path }
  })
}

export interface ProjectOpenResult {
  project: MappaProject
  path: string
  missingPacks: string[]
}

export async function openProjectFile(
  map: MapLibreMap | null,
): Promise<ProjectOpenResult | null> {
  requireNative()
  const selected = await open({
    multiple: false,
    directory: false,
    title: tr('Открыть проект', 'Open project'),
    filters: [
          { name: tr('Проект Mappa', 'Mappa project'), extensions: ['mappa'] },
        ],
  })
  const path = Array.isArray(selected) ? selected[0] : selected
  if (typeof path !== 'string' || path.length === 0) return null
  return openProjectPath(path, map)
}

/** Opens a known project path (used by the recent-project list). */
export async function openProjectPath(
  path: string,
  map: MapLibreMap | null,
): Promise<ProjectOpenResult> {
  const parsed = parseProject(await readTextFile(path))
  const missingPacks = await applyProject(
    parsed.file,
    parsed.features,
    path,
    map,
  )
  useAppStore.getState().addRecentProject({
    name: parsed.file.name,
    path,
    at: Date.now(),
  })
  return { project: parsed.file, path, missingPacks }
}

/** Replaces the current workspace and reopens the project's packs. */
export async function applyProject(
  project: MappaProject,
  features: MapFeature[],
  path: string | null,
  map: MapLibreMap | null,
): Promise<string[]> {
  return serialize(async () => {
    for (const pack of [...useAppStore.getState().packs]) {
      try {
        await closePack(pack.id)
      } catch (error) {
        console.warn('cannot close pack', pack.path, error)
        useAppStore.getState().removePack(pack.id)
      }
    }
    useAppStore.setState({
      providerId: project.providerId,
      providerOrder: project.providerOrder,
      layers: project.layers,
      markers: project.markers,
      features,
      vectorLayers: project.vectorLayers,
      customLayers: project.customLayers,
      coordinateFormat: project.coordinateFormat,
      crs: project.crs,
      crsLabel: project.crsLabel,
      packPaths: [],
      packs: [],
      selection: null,
      selectionPolygon: null,
      selectedFeatureId: null,
      selectedVector: null,
      selectedMarkerId: null,
      featureMode: 'off',
      draftPoints: [],
      drawing: false,
      measureMode: null,
      measurePoints: [],
      placingMarker: false,
      downloadOpen: false,
      projectName: project.name,
      projectPath: path,
    })
    useAppStore.getState().clearHistory()

    const missingPacks: string[] = []
    for (const packPath of project.packPaths) {
      try {
        await openPackPath(packPath)
      } catch (error) {
        console.warn('cannot open project pack', packPath, error)
        missingPacks.push(packPath)
      }
    }
    useViewStore.getState().setMapView({
      center: project.view.center,
      zoom: project.view.zoom,
      bounds: null,
      scale: 0,
    })
    map?.flyTo({
      center: project.view.center,
      zoom: project.view.zoom,
      duration: 600,
    })
    return missingPacks
  })
}

/** Closes packs and resets the map to an empty workspace. */
export async function newProject(
  map: MapLibreMap | null,
): Promise<MappaProject> {
  const project = defaultProject()
  await applyProject(project, [], null, map)
  return project
}
