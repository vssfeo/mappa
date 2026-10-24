import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import {
  Columns2,
  Crop,
  Download,
  FolderOpen,
  Globe2,
  Keyboard,
  Layers3,
  ListTodo,
  Map as MapIcon,
  MapPin,
  Minus,
  PackageOpen,
  PenLine,
  Pentagon,
  Plus,
  Ruler,
  Save,
  Spline,
  Sun,
  SunMoon,
  XCircle,
} from 'lucide-react'
import { CommandPalette } from './CommandPalette'
import { useCoverageStore } from './coverage'
import { useT, useText } from './i18n'
import { DownloadSheet } from './DownloadSheet'
import { useDownloadsStore } from './downloads'
import { Inspector } from './Inspector'
import { MapCanvas } from './MapCanvas'
import { MapHud } from './MapHud'
import { Rail } from './Rail'
import { Shortcuts } from './Shortcuts'
import { StatusBar } from './StatusBar'
import { Toast } from './Toast'
import { TopBar } from './TopBar'
import type { Command } from './commands'
import { listCustomSources } from './customSources'
import { transformPoints } from './native'
import { importPack, restorePacks } from './packs'
import {
  newProject,
  openProjectFile,
  saveProjectFile,
  startAutosave,
} from './projectTransfer'
import {
  formatCoordinatePair,
  parseCoordinateText,
  type LonLat,
} from './geo'
import { markerId } from './markers'
import { PROVIDERS } from './providers'
import { useAppStore } from './store'
import { useViewStore } from './viewStore'
import './App.css'

const isTypingTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}

function App() {
  const theme = useAppStore((state) => state.theme)
  const layers = useAppStore((state) => state.layers)
  const providerId = useAppStore((state) => state.providerId)
  const packs = useAppStore((state) => state.packs)
  const customSources = useAppStore((state) => state.customSources)
  const customLayers = useAppStore((state) => state.customLayers)
  const t = useT()
  const tx = useText()
  const locale = useAppStore((state) => state.locale)
  const panel = useAppStore((state) => state.panel)
  const fieldMode = useAppStore((state) => state.fieldMode)
  const selection = useAppStore((state) => state.selection)
  const drawing = useAppStore((state) => state.drawing)
  const measureMode = useAppStore((state) => state.measureMode)
  const measurePoints = useAppStore((state) => state.measurePoints)
  const markers = useAppStore((state) => state.markers)
  const selectedMarkerId = useAppStore((state) => state.selectedMarkerId)
  const placingMarker = useAppStore((state) => state.placingMarker)
  const features = useAppStore((state) => state.features)
  const featureMode = useAppStore((state) => state.featureMode)
  const draftPoints = useAppStore((state) => state.draftPoints)
  const selectedFeatureId = useAppStore((state) => state.selectedFeatureId)
  const selectedVector = useAppStore((state) => state.selectedVector)
  const selectVectorFeature = useAppStore(
    (state) => state.selectVectorFeature,
  )
  const moveVectorVertex = useAppStore((state) => state.moveVectorVertex)
  const insertVectorVertex = useAppStore((state) => state.insertVectorVertex)
  const deleteVectorVertex = useAppStore((state) => state.deleteVectorVertex)
  const setFeatureMode = useAppStore((state) => state.setFeatureMode)
  const addDraftPoint = useAppStore((state) => state.addDraftPoint)
  const undoDraftPoint = useAppStore((state) => state.undoDraftPoint)
  const undo = useAppStore((state) => state.undo)
  const redo = useAppStore((state) => state.redo)
  const finishDraft = useAppStore((state) => state.finishDraft)
  const selectFeature = useAppStore((state) => state.selectFeature)
  const moveFeatureVertex = useAppStore((state) => state.moveFeatureVertex)
  const deleteFeatureVertex = useAppStore((state) => state.deleteFeatureVertex)
  const removeFeature = useAppStore((state) => state.removeFeature)
  const selectionPolygon = useAppStore((state) => state.selectionPolygon)
  const setSelection = useAppStore((state) => state.setSelection)
  const setDrawing = useAppStore((state) => state.setDrawing)
  const setMeasureMode = useAppStore((state) => state.setMeasureMode)
  const addMeasurePoint = useAppStore((state) => state.addMeasurePoint)
  const undoMeasurePoint = useAppStore((state) => state.undoMeasurePoint)
  const clearMeasure = useAppStore((state) => state.clearMeasure)
  const setPlacingMarker = useAppStore((state) => state.setPlacingMarker)
  const setSelectedMarker = useAppStore((state) => state.setSelectedMarker)
  const updateMarker = useAppStore((state) => state.updateMarker)
  const coordinateFormat = useAppStore((state) => state.coordinateFormat)
  const crs = useAppStore((state) => state.crs)
  const crsLabel = useAppStore((state) => state.crsLabel)
  const commandOpen = useAppStore((state) => state.commandOpen)
  const shortcutsOpen = useAppStore((state) => state.shortcutsOpen)
  const setShortcutsOpen = useAppStore((state) => state.setShortcutsOpen)
  const setCommandOpen = useAppStore((state) => state.setCommandOpen)
  const setDownloadOpen = useAppStore((state) => state.setDownloadOpen)
  const setPanel = useAppStore((state) => state.setPanel)
  const setProviderId = useAppStore((state) => state.setProviderId)
  const setMapView = useViewStore((state) => state.setMapView)
  const setCursor = useViewStore((state) => state.setCursor)
  const vectorLayers = useAppStore((state) => state.vectorLayers)
  const snapping = useAppStore((state) => state.snapping)
  const mapGrid = useAppStore((state) => state.mapGrid)
  const coverageVisible = useCoverageStore((state) => state.visible)
  const coverageTiles = useCoverageStore((state) => state.tiles)
  const refreshCoverage = useCoverageStore((state) => state.refresh)
  const toggleFieldMode = useAppStore((state) => state.toggleFieldMode)
  const toggleTheme = useAppStore((state) => state.toggleTheme)
  const showToast = useAppStore((state) => state.showToast)

  const [map, setMap] = useState<MapLibreMap | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }, [theme])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => startAutosave(), [])

  useEffect(() => {
    void useDownloadsStore.getState().init()
    void restorePacks()
    void listCustomSources().then((sources) =>
      useAppStore.getState().setCustomSources(sources),
    )
  }, [])

  useEffect(() => {
    if (!coverageVisible) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void refreshCoverage(providerId)
      }, 450)
    }
    void refreshCoverage(providerId)
    const unsubscribe = useViewStore.subscribe((state, previous) => {
      if (state.mapView.bounds !== previous.mapView.bounds) schedule()
    })
    return () => {
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
    }
  }, [coverageVisible, providerId, refreshCoverage])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      // Physical letter codes keep shortcuts working in Russian layouts.
      const letter = event.code.startsWith('Key')
        ? event.code.slice(3).toLowerCase()
        : ''

      if (mod && letter === 'k') {
        event.preventDefault()
        setCommandOpen(!commandOpen)
        return
      }
      if (mod && letter === 'j') {
        event.preventDefault()
        setPanel('downloads')
        return
      }
      if (mod && letter === 's') {
        event.preventDefault()
        void saveProjectFile({ saveAs: event.shiftKey })
          .then((result) => {
            if (result)
              showToast(
                tx(
                  `Проект сохранён: ${result.path}`,
                  `Project saved: ${result.path}`,
                ),
              )
          })
          .catch((error: unknown) =>
            showToast(
              tx(
                `Не удалось сохранить проект: ${String(error)}`,
                `Could not save the project: ${String(error)}`,
              ),
            ),
          )
        return
      }
      if (mod && letter === 'o') {
        event.preventDefault()
        void openProjectFile(map)
          .then((result) => {
            if (!result) return
            setPanel('projects')
            showToast(
              result.missingPacks.length > 0
                ? tx(
                    `Проект открыт, не найдено паков: ${result.missingPacks.length}`,
                    `Project opened, missing packs: ${result.missingPacks.length}`,
                  )
                : tx(
                    `Проект открыт: ${result.project.name}`,
                    `Project opened: ${result.project.name}`,
                  ),
            )
          })
          .catch((error: unknown) =>
            showToast(
              tx(
                `Не удалось открыть проект: ${String(error)}`,
                `Could not open the project: ${String(error)}`,
              ),
            ),
          )
        return
      }
      if (event.key === 'Escape') {
        const state = useAppStore.getState()
        if (state.drawing) state.setDrawing(false)
        else if (state.placingMarker) state.setPlacingMarker(false)
        else if (state.featureMode !== 'off') state.cancelDraft()
        else if (state.measureMode) {
          state.setMeasureMode(null)
          state.clearMeasure()
        } else if (state.measurePoints.length > 0) state.clearMeasure()
        else if (commandOpen) setCommandOpen(false)
        else if (shortcutsOpen) setShortcutsOpen(false)
        else if (state.downloadOpen) setDownloadOpen(false)
        else setPanel(null)
        return
      }
      if (isTypingTarget(event.target)) return

      if (mod && letter === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (mod && letter === 'y') {
        event.preventDefault()
        redo()
        return
      }

      if (event.key === 'Enter' && (featureMode === 'draw-line' || featureMode === 'draw-polygon')) {
        event.preventDefault()
        finishDraft()
        return
      }

      if (event.key === 'Backspace') {
        if (featureMode === 'draw-line' || featureMode === 'draw-polygon') {
          event.preventDefault()
          undoDraftPoint()
          return
        }
        if (measureMode) {
          event.preventDefault()
          undoMeasurePoint()
          return
        }
      }

      if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        featureMode === 'edit' &&
        selectedFeatureId
      ) {
        event.preventDefault()
        removeFeature(selectedFeatureId)
        return
      }

      switch (letter) {
        case 'd':
          event.preventDefault()
          setDownloadOpen(true)
          break
        case 'r':
          event.preventDefault()
          setDrawing(true)
          showToast(
            tx(
              'Протяните прямоугольник по карте. Esc — отмена',
              'Drag a rectangle on the map. Esc cancels',
            ),
          )
          break
        case 'l':
          event.preventDefault()
          if (event.shiftKey) {
            setFeatureMode('draw-polygon')
            setPanel('features')
            showToast(
              tx(
                'Кликайте вершины полигона. Enter — завершить, Esc — отмена',
                'Click polygon vertices. Enter finishes, Esc cancels',
              ),
            )
          } else {
            setFeatureMode('draw-line')
            setPanel('features')
            showToast(
              tx(
                'Кликайте вершины линии. Enter — завершить, Esc — отмена',
                'Click line vertices. Enter finishes, Esc cancels',
              ),
            )
          }
          break
        case 'e':
          event.preventDefault()
          setFeatureMode(featureMode === 'edit' ? 'off' : 'edit')
          setPanel('features')
          showToast(
            featureMode === 'edit'
              ? tx('Режим редактирования выключен', 'Edit mode is off')
              : tx(
                  'Кликните линию или полигон, затем тяните вершины',
                  'Click a line or polygon, then drag its vertices',
                ),
          )
          break
        case 'f':
          event.preventDefault()
          toggleFieldMode()
          break
        case 't':
          event.preventDefault()
          toggleTheme()
          break
        case 'm':
          event.preventDefault()
          if (event.shiftKey) {
            setMeasureMode('area')
            showToast(
              tx(
                'Кликайте вершины полигона. Esc — очистить',
                'Click polygon vertices. Esc clears',
              ),
            )
          } else {
            setMeasureMode('line')
            showToast(
              tx(
                'Кликайте вершины линии. Esc — очистить',
                'Click line vertices. Esc clears',
              ),
            )
          }
          break
        case 'p':
          event.preventDefault()
          setPlacingMarker(!placingMarker)
          setPanel('markers')
          break
        case 'c':
          event.preventDefault()
          showToast(tx('Сравнение подложек — Phase 4', 'Basemap comparison — Phase 4'))
          break
        case 'v':
          event.preventDefault()
          setPanel(null)
          break
        default:
          break
      }

      switch (key) {
        case '?':
          event.preventDefault()
          setShortcutsOpen(true)
          break
        case '0':
          event.preventDefault()
          map?.easeTo({ center: [0, 20], zoom: 1, duration: 450 })
          break
        case '+':
        case '=':
          event.preventDefault()
          map?.zoomIn({ duration: 180 })
          break
        case '-':
          event.preventDefault()
          map?.zoomOut({ duration: 180 })
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    commandOpen,
    shortcutsOpen,
    map,
    measureMode,
    placingMarker,
    featureMode,
    selectedFeatureId,
    finishDraft,
    undoDraftPoint,
    removeFeature,
    setFeatureMode,
    setCommandOpen,
    setDownloadOpen,
    setDrawing,
    setMeasureMode,
    setPanel,
    setPlacingMarker,
    setShortcutsOpen,
    showToast,
    toggleFieldMode,
    toggleTheme,
    tx,
    undoMeasurePoint,
    undo,
    redo,
  ])

  const onReady = useCallback((instance: MapLibreMap) => {
    setMap(instance)
  }, [])

  const onViewChange = useCallback(
    (view: Parameters<typeof setMapView>[0]) => {
      setMapView(view)
    },
    [setMapView],
  )

  const onCursor = useCallback(
    (coords: [number, number] | null) => {
      setCursor(coords)
    },
    [setCursor],
  )

  const lastMapError = useRef(0)
  const onMapError = useCallback(
    (message: string) => {
      const now = Date.now()
      if (now - lastMapError.current < 15_000) return
      lastMapError.current = now
      showToast(
        tx(
          `Подложка: ${message.slice(0, 180)}`,
          `Basemap: ${message.slice(0, 180)}`,
        ),
      )
    },
    [showToast, tx],
  )

  const onPlaceMarker = useCallback((point: LonLat) => {
    const state = useAppStore.getState()
    state.addMarker({
      id: markerId(),
      name: tx(
        `Метка ${state.markers.length + 1}`,
        `Marker ${state.markers.length + 1}`,
      ),
      lon: point[0],
      lat: point[1],
    })
    state.setPanel('markers')
    state.showToast(
      tx(
        'Метка добавлена — переименуйте её в панели',
        'Marker added — rename it in the panel',
      ),
    )
  }, [tx])

  const onMoveMarker = useCallback(
    (id: string, point: LonLat) => {
      updateMarker(id, { lon: point[0], lat: point[1] })
    },
    [updateMarker],
  )

  const onSelectMarker = useCallback(
    (id: string | null) => {
      setSelectedMarker(id)
      if (id) setPanel('markers')
    },
    [setPanel, setSelectedMarker],
  )

  const resolveCommand = useCallback(
    (query: string): Command | null => {
      if (crs) {
        const numbers = query
          .split(/[\s,;]+/)
          .filter(Boolean)
          .map(Number)
        if (numbers.length === 2 && numbers.every(Number.isFinite)) {
          const [x, y] = numbers
          return {
            id: 'goto-crs',
            label: tx(
              `Перейти: ${x}, ${y} · ${crsLabel || 'CRS'}`,
              `Go to: ${x}, ${y} · ${crsLabel || 'CRS'}`,
            ),
            group: tx('Координаты', 'Coordinates'),
            hint: 'Enter',
            keywords: ['goto', 'координаты', 'crs', 'epsg'],
            icon: MapPin,
            action: () => {
              void transformPoints(crs, { epsg: 4326 }, [[x, y]])
                .then((points) => {
                  const point = points[0]
                  if (!point) return
                  const [lon, lat] = point
                  if (
                    !Number.isFinite(lon) ||
                    !Number.isFinite(lat) ||
                    Math.abs(lon) > 180 ||
                    Math.abs(lat) > 90
                  ) {
                    throw new Error(
                      tx(
                        'координаты вне допустимого диапазона',
                        'coordinates are outside the valid range',
                      ),
                    )
                  }
                  map?.flyTo({
                    center: [lon, lat],
                    zoom: Math.max(map.getZoom(), 12),
                    duration: 900,
                  })
                })
                .catch((error: unknown) =>
                  showToast(
                    tx(
                      `Не удалось перейти: ${String(error)}`,
                      `Could not navigate: ${String(error)}`,
                    ),
                  ),
                )
            },
          }
        }
      }

      const parsed = parseCoordinateText(query)
      if (!parsed) return null
      const [lon, lat] = parsed.point
      return {
        id: 'goto-coordinates',
        label: tx(
          `Перейти: ${formatCoordinatePair(lon, lat, coordinateFormat)}`,
          `Go to: ${formatCoordinatePair(lon, lat, coordinateFormat)}`,
        ),
        group: tx('Координаты', 'Coordinates'),
        hint: 'Enter',
        keywords: ['goto', 'координаты'],
        icon: MapPin,
        action: () => {
          if (!map) return
          map.flyTo({
            center: [lon, lat],
            zoom: Math.max(map.getZoom(), 12),
            duration: 900,
          })
        },
      }
    },
    [coordinateFormat, crs, crsLabel, map, showToast, tx],
  )

  const mapHint = drawing
    ? t('hud.selectHint')
    : placingMarker
      ? t('hud.placeMarker')
      : featureMode === 'draw-line'
        ? t('hud.drawLine')
        : featureMode === 'draw-polygon'
          ? t('hud.drawPolygon')
          : featureMode === 'edit'
            ? selectedVector
              ? tx(
                  'Тяните вершины · клик по точке на сегменте — вставить · правый клик — удалить',
                  'Drag vertices · click a segment dot to insert · right-click to delete',
                )
              : tx(
                  'Кликните объект · тяните вершины · правый клик — удалить',
                  'Click a feature · drag vertices · right-click to delete',
                )
            : measureMode === 'line'
              ? t('hud.measureLine')
              : measureMode === 'area'
                ? t('hud.measureArea')
                : null

  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'theme',
        label: tx('Переключить тему', 'Toggle theme'),
        group: tx('Вид', 'View'),
        hint: 'T',
        icon: SunMoon,
        action: toggleTheme,
      },
      {
        id: 'download',
        label: tx('Скачать текущий экран', 'Download the current view'),
        group: tx('Загрузки', 'Downloads'),
        hint: 'D',
        icon: Download,
        action: () => setDownloadOpen(true),
      },
      {
        id: 'select-area',
        label: tx('Выделить область', 'Select an area'),
        group: tx('Загрузки', 'Downloads'),
        hint: 'R',
        keywords: ['bbox', 'район', 'прямоугольник'],
        icon: Crop,
        action: () => {
          setDrawing(true)
          showToast(
            tx(
              'Протяните прямоугольник по карте. Esc — отмена',
              'Drag a rectangle on the map. Esc cancels',
            ),
          )
        },
      },
      {
        id: 'downloads',
        label: tx('Центр загрузок', 'Download centre'),
        group: tx('Загрузки', 'Downloads'),
        hint: 'Ctrl J',
        icon: ListTodo,
        action: () => setPanel('downloads'),
      },
      {
        id: 'import-pack',
        label: tx('Импорт офлайн-пака', 'Import an offline pack'),
        group: tx('Проект', 'Project'),
        keywords: ['mbtiles', 'pmtiles', 'pack', 'пак'],
        icon: PackageOpen,
        action: () => {
          void importPack()
            .then((pack) => {
              if (!pack) return
              setPanel('layers')
              showToast(tx(`Пак открыт: ${pack.name}`, `Pack opened: ${pack.name}`))
            })
            .catch((error: unknown) =>
              showToast(
                tx(
                  `Не удалось открыть пак: ${String(error)}`,
                  `Could not open the pack: ${String(error)}`,
                ),
              ),
            )
        },
      },
      {
        id: 'project-save',
        label: tx('Сохранить проект', 'Save project'),
        group: tx('Проект', 'Project'),
        hint: 'Ctrl S',
        keywords: ['mappa', 'save', 'сохранить'],
        icon: Save,
        action: () => {
          void saveProjectFile()
            .then((result) => {
              if (result)
                showToast(
                  tx(
                    `Проект сохранён: ${result.path}`,
                    `Project saved: ${result.path}`,
                  ),
                )
            })
            .catch((error: unknown) =>
              showToast(
                tx(
                  `Не удалось сохранить проект: ${String(error)}`,
                  `Could not save the project: ${String(error)}`,
                ),
              ),
            )
        },
      },
      {
        id: 'project-open',
        label: tx('Открыть проект', 'Open project'),
        group: tx('Проект', 'Project'),
        hint: 'Ctrl O',
        keywords: ['mappa', 'open', 'открыть'],
        icon: FolderOpen,
        action: () => {
          void openProjectFile(map)
            .then((result) => {
              if (!result) return
              setPanel('projects')
              showToast(
                tx(
                  `Проект открыт: ${result.project.name}`,
                  `Project opened: ${result.project.name}`,
                ),
              )
            })
            .catch((error: unknown) =>
              showToast(
                tx(
                  `Не удалось открыть проект: ${String(error)}`,
                  `Could not open the project: ${String(error)}`,
                ),
              ),
            )
        },
      },
      {
        id: 'project-new',
        label: tx('Новый проект', 'New project'),
        group: tx('Проект', 'Project'),
        keywords: ['mappa', 'new', 'новый'],
        icon: Plus,
        action: () => {
          if (
            !window.confirm(
              tx(
                'Создать новый проект? Несохранённые метки, объекты и открытые паки будут очищены.',
                'Create a new project? Unsaved markers, features and open packs will be cleared.',
              ),
            )
          ) {
            return
          }
          void newProject(map)
            .then(() => {
              setPanel('projects')
              showToast(tx('Новый проект создан', 'New project created'))
            })
            .catch((error: unknown) =>
              showToast(
                tx(
                  `Не удалось создать проект: ${String(error)}`,
                  `Could not create the project: ${String(error)}`,
                ),
              ),
            )
        },
      },
      {
        id: 'layers',
        label: tx('Показать слои', 'Show layers'),
        group: tx('Вид', 'View'),
        icon: Layers3,
        action: () => setPanel('layers'),
      },
      ...PROVIDERS.map<Command>((provider) => ({
        id: `provider-${provider.id}`,
        label: tx(`Подложка: ${provider.label}`, `Basemap: ${provider.label}`),
        group: tx('Подложка', 'Basemap'),
        keywords: ['карта', 'слой', provider.short],
        icon: MapIcon,
        action: () => setProviderId(provider.id),
      })),
      {
        id: 'zoom-in',
        label: tx('Приблизить', 'Zoom in'),
        group: tx('Навигация', 'Navigation'),
        hint: '+',
        icon: Plus,
        action: () => map?.zoomIn({ duration: 180 }),
      },
      {
        id: 'zoom-out',
        label: tx('Отдалить', 'Zoom out'),
        group: tx('Навигация', 'Navigation'),
        hint: '−',
        icon: Minus,
        action: () => map?.zoomOut({ duration: 180 }),
      },
      {
        id: 'moscow',
        label: tx('Перейти: Москва', 'Go to: Moscow'),
        group: tx('Перейти', 'Go to'),
        keywords: ['moscow', 'россия'],
        icon: MapPin,
        action: () =>
          map?.flyTo({ center: [37.6173, 55.7558], zoom: 11, duration: 900 }),
      },
      {
        id: 'spb',
        label: tx('Перейти: Санкт-Петербург', 'Go to: Saint Petersburg'),
        group: tx('Перейти', 'Go to'),
        keywords: ['petersburg', 'питер'],
        icon: MapPin,
        action: () =>
          map?.flyTo({ center: [30.3159, 59.9391], zoom: 11, duration: 900 }),
      },
      {
        id: 'sf',
        label: tx('Перейти: Сан-Франциско', 'Go to: San Francisco'),
        group: tx('Перейти', 'Go to'),
        keywords: ['usa', 'usgs', 'сша', 'сан-франциско'],
        icon: MapPin,
        action: () =>
          map?.flyTo({ center: [-122.45, 37.78], zoom: 11, duration: 900 }),
      },
      {
        id: 'world',
        label: tx('Показать весь мир', 'Show the whole world'),
        group: tx('Перейти', 'Go to'),
        hint: '0',
        icon: Globe2,
        action: () => map?.easeTo({ center: [0, 20], zoom: 1, duration: 450 }),
      },
      {
        id: 'field',
        label: tx('Полевой режим', 'Field mode'),
        group: tx('Вид', 'View'),
        hint: 'F',
        icon: Sun,
        action: toggleFieldMode,
      },
      {
        id: 'measure-line',
        label: tx('Линейка: расстояние и азимут', 'Ruler: distance and bearing'),
        group: tx('Измерения', 'Measurements'),
        hint: 'M',
        keywords: ['ruler', 'азимут', 'линия'],
        icon: Ruler,
        action: () => {
          setMeasureMode('line')
          showToast(
            tx(
              'Кликайте вершины линии. Esc — очистить',
              'Click line vertices. Esc clears',
            ),
          )
        },
      },
      {
        id: 'measure-area',
        label: tx('Измерить площадь полигона', 'Measure polygon area'),
        group: tx('Измерения', 'Measurements'),
        hint: 'Shift M',
        keywords: ['площадь', 'area', 'полигон'],
        icon: Pentagon,
        action: () => {
          setMeasureMode('area')
          showToast(
            tx(
              'Кликайте вершины полигона. Esc — очистить',
              'Click polygon vertices. Esc clears',
            ),
          )
        },
      },
      {
        id: 'clear-measure',
        label: tx('Очистить измерения', 'Clear measurements'),
        group: tx('Измерения', 'Measurements'),
        icon: XCircle,
        action: () => {
          clearMeasure()
          setMeasureMode(null)
        },
      },
      {
        id: 'draw-line',
        label: tx('Нарисовать линию', 'Draw line'),
        group: tx('Объекты', 'Features'),
        hint: 'L',
        keywords: ['line', 'линия', 'рисовать'],
        icon: Spline,
        action: () => {
          setFeatureMode('draw-line')
          setPanel('features')
          showToast(
            tx(
              'Кликайте вершины линии. Enter — сохранить, Esc — отмена',
              'Click line vertices. Enter saves, Esc cancels',
            ),
          )
        },
      },
      {
        id: 'draw-polygon',
        label: tx('Нарисовать полигон', 'Draw polygon'),
        group: tx('Объекты', 'Features'),
        hint: 'Shift L',
        keywords: ['polygon', 'полигон', 'площадь', 'рисовать'],
        icon: Pentagon,
        action: () => {
          setFeatureMode('draw-polygon')
          setPanel('features')
          showToast(
            tx(
              'Кликайте вершины полигона. Enter — сохранить, Esc — отмена',
              'Click polygon vertices. Enter saves, Esc cancels',
            ),
          )
        },
      },
      {
        id: 'edit-features',
        label: tx(
          'Редактировать линии и полигоны',
          'Edit lines and polygons',
        ),
        group: tx('Объекты', 'Features'),
        hint: 'E',
        keywords: ['edit', 'вершины', 'редактировать'],
        icon: PenLine,
        action: () => {
          setFeatureMode(featureMode === 'edit' ? 'off' : 'edit')
          setPanel('features')
        },
      },
      {
        id: 'features',
        label: tx('Мои объекты', 'My features'),
        group: tx('Проект', 'Project'),
        keywords: ['features', 'линии', 'полигоны'],
        icon: Layers3,
        action: () => setPanel('features'),
      },
      {
        id: 'compare',
        label: tx('Сравнить подложки', 'Compare basemaps'),
        group: tx('Инструменты', 'Tools'),
        hint: 'C',
        icon: Columns2,
        action: () =>
          showToast(tx('Сравнение подложек — Phase 4', 'Basemap comparison — Phase 4')),
      },
      {
        id: 'markers',
        label: tx('Метки', 'Markers'),
        group: tx('Проект', 'Project'),
        keywords: ['markers', 'точки', 'метки'],
        icon: MapPin,
        action: () => setPanel('markers'),
      },
      {
        id: 'place-marker',
        label: tx('Поставить метку', 'Place marker'),
        group: tx('Проект', 'Project'),
        hint: 'P',
        icon: MapPin,
        action: () => {
          setPlacingMarker(true)
          setPanel('markers')
          showToast(
            tx(
              'Кликните по карте, чтобы поставить метку. Esc — закончить',
              'Click the map to place a marker. Esc finishes',
            ),
          )
        },
      },
      {
        id: 'projects',
        label: tx('Проекты', 'Projects'),
        group: tx('Проект', 'Project'),
        icon: FolderOpen,
        action: () => setPanel('projects'),
      },
      {
        id: 'shortcuts',
        label: tx('Горячие клавиши', 'Keyboard shortcuts'),
        group: tx('Помощь', 'Help'),
        hint: '?',
        icon: Keyboard,
        action: () => setShortcutsOpen(true),
      },
    ],
    [
      clearMeasure,
      featureMode,
      map,
      setDownloadOpen,
      setDrawing,
      setFeatureMode,
      setMeasureMode,
      setPanel,
      setPlacingMarker,
      setProviderId,
      setShortcutsOpen,
      showToast,
      toggleFieldMode,
      toggleTheme,
      tx,
    ],
  )

  return (
    <div className={`app${fieldMode ? ' field-mode' : ''}`} data-theme={theme}>
      <a className="skip-link" href="#map-stage">
        {t('a11y.skip')}
      </a>
      <TopBar />
      <div className="workspace">
        <Rail />
        <main
          id="map-stage"
          tabIndex={-1}
          aria-label={t('a11y.map')}
          className={`map-stage${panel ? ' has-inspector' : ''}`}
        >
          <MapCanvas
            layers={layers}
            providerId={providerId}
            packs={packs}
            customSources={customSources}
            customLayers={customLayers}
            theme={theme}
            selection={selection}
            selectionPolygon={selectionPolygon}
            coverageTiles={coverageVisible ? coverageTiles : null}
            vectorLayers={vectorLayers}
            snapping={snapping}
            grid={mapGrid}
            drawing={drawing}
            measureMode={measureMode}
            measurePoints={measurePoints}
            features={features}
            featureMode={featureMode}
            draftPoints={draftPoints}
            selectedFeatureId={selectedFeatureId}
            selectedVector={selectedVector}
            markers={markers}
            selectedMarkerId={selectedMarkerId}
            placingMarker={placingMarker}
            onViewChange={onViewChange}
            onCursor={onCursor}
            onMapError={onMapError}
            onSelectionChange={setSelection}
            onDrawingChange={setDrawing}
            onMeasurePoint={addMeasurePoint}
            onAddDraftPoint={addDraftPoint}
            onFinishDraft={finishDraft}
            onSelectFeature={selectFeature}
            onMoveFeatureVertex={moveFeatureVertex}
            onDeleteFeatureVertex={deleteFeatureVertex}
            onSelectVectorFeature={selectVectorFeature}
            onMoveVectorVertex={moveVectorVertex}
            onInsertVectorVertex={insertVectorVertex}
            onDeleteVectorVertex={deleteVectorVertex}
            onPlaceMarker={onPlaceMarker}
            onMoveMarker={onMoveMarker}
            onSelectMarker={onSelectMarker}
            onReady={onReady}
          />
          <MapHud map={map} />
          {mapHint && (
            <div className="draw-hint">
              {mapHint} <kbd>Esc</kbd>
            </div>
          )}
        </main>
        <Inspector map={map} />
        <DownloadSheet />
      </div>
      <StatusBar />

      {commandOpen && (
        <CommandPalette
          commands={commands}
          resolve={resolveCommand}
          onClose={() => setCommandOpen(false)}
        />
      )}
      {shortcutsOpen && (
        <Shortcuts onClose={() => setShortcutsOpen(false)} />
      )}
      <Toast />
    </div>
  )
}

export default App
