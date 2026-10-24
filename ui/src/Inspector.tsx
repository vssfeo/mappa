import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Marker, type Map as MapLibreMap } from 'maplibre-gl'
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clock3,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileDown,
  FolderOpen,
  Globe2,
  HardDrive,
  Layers3,
  Loader2,
  MapPin,
  Network,
  PackageOpen,
  Pause,
  PenLine,
  Pentagon,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Spline,
  Table2,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react'
import {
  deleteCustomSource,
  formatHeaders,
  listCustomSources,
  parseHeaders,
  saveCustomSource,
  type CustomSource,
  type CustomSourceDraft,
} from './customSources'
import { useCoverageStore } from './coverage'
import { formatBytes, formatCount, formatDuration } from './format'
import {
  distance,
  formatArea,
  formatCoordinatePair,
  formatDistance,
  parseCoordinateText,
  pathLength,
  polygonArea,
} from './geo'
import { magneticField } from './geomag'
import { meridianConvergence, pointScaleFactor } from './geodesy'
import { lonLatToMgrs } from './mgrs'
import { useViewStore } from './viewStore'
import {
  FEATURE_COLORS,
  featureArea,
  featureLength,
  pointAlongLine,
  type MapFeature,
} from './features'
import { exportFeatureFile, importFeatureFile } from './featureTransfer'
import { importMarkerFile, exportMarkerFile } from './markerTransfer'
import {
  newProject,
  openProjectFile,
  openProjectPath,
  readAutosave,
  restoreAutosave,
  saveProjectFile,
  type AutosaveSnapshot,
} from './projectTransfer'
import type {
  CoordinateFormat,
  MapMarker,
  MarkerFileFormat,
} from './markers'
import {
  useDownloadsStore,
  type DownloadJob,
  type JobStatus,
} from './downloads'
import {
  cachePath,
  cacheStats,
  cacheStatsByProvider,
  clearCache,
  crsPresets,
  getSettings,
  isNative,
  importXyzFolder,
  openLogDirectory,
  transformPoints,
  updateSettings,
  verifyCache,
  wmtsCapabilities,
  type CrsPreset,
  type GeoPackageLayer,
  type NativeCacheStats,
  type NativeSettings,
  type ProviderCacheStats,
  type WmtsLayer,
} from './native'
import { closePack, importPack, openPackPath } from './packs'
import {
  exportMapGeoTiff,
  exportMapPdf,
  exportMapPng,
  type MapExportFormat,
} from './mapExport'
import {
  exportVectorLayerKmz,
  importVectorLayerFile,
} from './vectorTransfer'
import {
  attributeTable,
  vectorBounds,
  type VectorLayer,
} from './vectorLayers'
import { PROVIDERS, providerById } from './providers'
import { useT, useText, type Locale, type MessageKey } from './i18n'
import { useDialogFocus } from './useDialogFocus'
import { useAppStore, type Panel } from './store'

const titles: Record<Exclude<Panel, null>, MessageKey> = {
  layers: 'panel.layers',
  downloads: 'panel.downloads',
  markers: 'panel.markers',
  features: 'panel.features',
  projects: 'panel.projects',
  settings: 'panel.settings',
}

const MIB = 1024 * 1024

const statusLabels: Record<JobStatus, [ru: string, en: string]> = {
  queued: ['В очереди', 'Queued'],
  running: ['Скачивается', 'Downloading'],
  paused: ['Пауза', 'Paused'],
  completed: ['Готово', 'Completed'],
  cancelled: ['Отменено', 'Cancelled'],
  failed: ['Ошибка', 'Failed'],
}

const StatusIcon = ({ status }: { status: JobStatus }) => {
  const size = 12
  switch (status) {
    case 'running':
      return <Loader2 size={size} className="spin" />
    case 'queued':
      return <Clock3 size={size} />
    case 'paused':
      return <Pause size={size} />
    case 'completed':
      return <CheckCircle2 size={size} />
    case 'cancelled':
      return <XCircle size={size} />
    case 'failed':
      return <AlertTriangle size={size} />
  }
}

function JobCard({
  job,
  onAction,
  onExport,
}: {
  job: DownloadJob
  onAction: (action: 'pause' | 'resume' | 'cancel' | 'delete') => void
  onExport: (kind: 'mbtiles' | 'pmtiles') => Promise<void>
}) {
  const tx = useText()
  const [exporting, setExporting] = useState<'mbtiles' | 'pmtiles' | null>(
    null,
  )
  const processed = job.doneTiles + job.failedTiles
  const percent =
    job.totalTiles > 0
      ? Math.min(100, (processed / job.totalTiles) * 100)
      : 0
  const active = job.status === 'running'
  const resumable = job.status === 'paused' || job.status === 'queued'

  return (
    <article className={`job-card is-${job.status}`}>
      <div className="job-heading">
        <div className="job-title">
          <strong>{job.name}</strong>
          <span>
            {job.providerId.toUpperCase()} · z{job.minZoom}–z{job.maxZoom}
          </span>
        </div>
        <span className={`job-status is-${job.status}`}>
          <StatusIcon status={job.status} />
          {tx(...statusLabels[job.status])}
        </span>
      </div>

      <div
        className="job-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-label={tx(`Прогресс ${job.name}`, `Progress ${job.name}`)}
      >
        <span style={{ width: `${percent}%` }} />
      </div>

      <div className="job-meta">
        <span>
          {formatCount(processed)} / {formatCount(job.totalTiles)}
        </span>
        <span>{formatBytes(job.bytes)}</span>
        {job.speedBytesPerSecond !== undefined &&
          job.speedBytesPerSecond > 0 && (
            <span>{formatBytes(job.speedBytesPerSecond)}/s</span>
          )}
        {job.etaSeconds != null && Number.isFinite(job.etaSeconds) && (
          <span>
            {tx('осталось', 'left')} {formatDuration(job.etaSeconds)}
          </span>
        )}
        {job.failedTiles > 0 && (
          <span className="job-failed">
            {formatCount(job.failedTiles)} {tx('ошибок', 'errors')}
          </span>
        )}
      </div>

      {job.error && <p className="job-error">{job.error}</p>}

      <div className="job-actions">
        {active && (
          <button
            type="button"
            className="ghost-button"
            onClick={() => onAction('pause')}
          >
            <Pause size={13} />
            {tx('Пауза', 'Pause')}
          </button>
        )}
        {!active && job.status !== 'queued' && (
          <>
            {(['mbtiles', 'pmtiles'] as const).map((kind) => (
              <button
                type="button"
                className="ghost-button"
                key={kind}
                disabled={exporting !== null}
                onClick={() => {
                  setExporting(kind)
                  void onExport(kind).finally(() => setExporting(null))
                }}
              >
                {exporting === kind ? (
                  <Loader2 size={13} className="spin" />
                ) : (
                  <FileDown size={13} />
                )}
                {kind === 'mbtiles' ? 'MBTiles' : 'PMTiles'}
              </button>
            ))}
          </>
        )}
        {resumable && (
          <button
            type="button"
            className="ghost-button"
            onClick={() => onAction('resume')}
          >
            <Play size={13} />
            {tx('Продолжить', 'Resume')}
          </button>
        )}
        {!active && !resumable && (
          <button
            type="button"
            className="ghost-button"
            onClick={() => onAction('delete')}
          >
            <Trash2 size={13} />
            {tx('Удалить', 'Delete')}
          </button>
        )}
        {(active || resumable) && (
          <button
            type="button"
            className="ghost-button is-danger"
            onClick={() => onAction('cancel')}
          >
            <XCircle size={13} />
            {tx('Отменить', 'Cancel')}
          </button>
        )}
      </div>
    </article>
  )
}

function MarkerCoordinateEditor({
  marker,
  defaultFormat,
  onApply,
}: {
  marker: MapMarker
  defaultFormat: CoordinateFormat
  onApply: (lon: number, lat: number) => void
}) {
  const tx = useText()
  const [format, setFormat] = useState<CoordinateFormat>(defaultFormat)
  const [value, setValue] = useState(() =>
    formatCoordinatePair(marker.lon, marker.lat, defaultFormat),
  )
  const [error, setError] = useState(false)

  const apply = () => {
    const parsed = parseCoordinateText(value)
    if (!parsed) {
      setError(true)
      return false
    }
    setError(false)
    const [lon, lat] = parsed.point
    onApply(lon, lat)
    setValue(formatCoordinatePair(lon, lat, format))
    return true
  }

  const changeFormat = (next: CoordinateFormat) => {
    setFormat(next)
    setValue(formatCoordinatePair(marker.lon, marker.lat, next))
    setError(false)
  }

  return (
    <div className="marker-coordinate-edit">
      <span className="marker-style-caption">
        {tx('Координаты точки', 'Point coordinates')}
      </span>
      <div className="marker-coordinate-row">
        <input
          value={value}
          onFocus={() => {
            setValue(formatCoordinatePair(marker.lon, marker.lat, format))
            setError(false)
          }}
          onBlur={() => {
            const current = formatCoordinatePair(marker.lon, marker.lat, format)
            if (value.trim() !== current.trim()) apply()
          }}
          onChange={(event) => {
            setValue(event.target.value)
            setError(false)
          }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') {
              event.preventDefault()
              apply()
            }
            if (event.key === 'Escape') {
              setValue(formatCoordinatePair(marker.lon, marker.lat, format))
              setError(false)
              event.currentTarget.blur()
            }
          }}
          aria-label={tx(
            `Координаты точки ${marker.name}`,
            `Point coordinates ${marker.name}`,
          )}
          aria-invalid={error}
          spellCheck={false}
        />
        <select
          value={format}
          onChange={(event) =>
            changeFormat(event.target.value as CoordinateFormat)
          }
          onKeyDown={(event) => event.stopPropagation()}
          aria-label={tx('Система координат точки', 'Point coordinate system')}
          title={tx('Система координат', 'Coordinate system')}
        >
          <option value="dd">WGS84 · {tx('градусы', 'degrees')}</option>
          <option value="dms">WGS84 · {tx('ГМС', 'DMS')}</option>
          <option value="utm">WGS84 · UTM</option>
          <option value="mgrs">WGS84 · MGRS</option>
        </select>
        <button
          type="button"
          className="ghost-button marker-coordinate-apply"
          onClick={apply}
          title={tx('Применить координаты', 'Apply coordinates')}
        >
          <CheckCircle2 size={13} />
          {tx('ОК', 'Apply')}
        </button>
      </div>
      {error && (
        <span className="marker-coordinate-error" role="alert">
          {tx(
            'Не удалось разобрать координаты. Поддерживаются градусы, ГМС, UTM и MGRS.',
            'Could not parse the coordinates. Degrees, DMS, UTM and MGRS are supported.',
          )}
        </span>
      )}
    </div>
  )
}

function MarkersPanel({ map }: { map: MapLibreMap | null }) {
  const tx = useText()
  const locale = useAppStore((state) => state.locale)
  const markers = useAppStore((state) => state.markers)
  const coordinateFormat = useAppStore((state) => state.coordinateFormat)
  const selectedMarkerId = useAppStore((state) => state.selectedMarkerId)
  const placingMarker = useAppStore((state) => state.placingMarker)
  const setCoordinateFormat = useAppStore((state) => state.setCoordinateFormat)
  const setPlacingMarker = useAppStore((state) => state.setPlacingMarker)
  const setSelectedMarker = useAppStore((state) => state.setSelectedMarker)
  const updateMarker = useAppStore((state) => state.updateMarker)
  const removeMarker = useAppStore((state) => state.removeMarker)
  const clearMarkers = useAppStore((state) => state.clearMarkers)
  const showToast = useAppStore((state) => state.showToast)
  const [fileFormat, setFileFormat] = useState<MarkerFileFormat>('csv')
  const [csvDelimiter, setCsvDelimiter] = useState(';')
  const [csvColumns, setCsvColumns] = useState({
    description: true,
    folder: true,
    icon: true,
    color: true,
  })
  const [busy, setBusy] = useState<'import' | 'export' | null>(null)
  const [visibleCount, setVisibleCount] = useState(200)
  const [query, setQuery] = useState('')
  const [folderFilter, setFolderFilter] = useState('all')

  const folders = Array.from(
    new Set(
      markers
        .map((marker) => marker.folder?.trim())
        .filter((folder): folder is string => Boolean(folder)),
    ),
  ).sort((left, right) => left.localeCompare(right, locale))
  const needle = query.trim().toLowerCase()
  const filtered = markers.filter((marker) => {
    const folder = marker.folder?.trim() ?? ''
    if (folderFilter === 'none' && folder) return false
    if (
      folderFilter !== 'all' &&
      folderFilter !== 'none' &&
      folder !== folderFilter
    ) {
      return false
    }
    if (!needle) return true
    return [marker.name, marker.description ?? '', folder].some((value) =>
      value.toLowerCase().includes(needle),
    )
  })
  const ordered = [...filtered].sort(
    (left, right) =>
      (left.folder ?? '').localeCompare(right.folder ?? '', locale) ||
      left.name.localeCompare(right.name, locale),
  )

  const runImport = async () => {
    setBusy('import')
    try {
      const result = await importMarkerFile(coordinateFormat)
      if (!result) return
      if (result.markers.length > 0 && map) {
        const bounds = result.markers.reduce<
          [[number, number], [number, number]]
        >(
          (box, marker) => [
            [Math.min(box[0][0], marker.lon), Math.min(box[0][1], marker.lat)],
            [Math.max(box[1][0], marker.lon), Math.max(box[1][1], marker.lat)],
          ],
          [
            [Infinity, Infinity],
            [-Infinity, -Infinity],
          ],
        )
        map.fitBounds(bounds, { padding: 70, maxZoom: 13, duration: 700 })
      }
      showToast(
        tx(
          `Импортировано ${formatCount(result.markers.length)} меток` +
            (result.skipped > 0
              ? ` · пропущено ${formatCount(result.skipped)}`
              : ''),
          `Imported ${formatCount(result.markers.length)} markers` +
            (result.skipped > 0
              ? ` · ${formatCount(result.skipped)} skipped`
              : ''),
        ),
      )
    } catch (error) {
      showToast(
        tx(
          `Импорт не удался: ${String(error)}`,
          `Import failed: ${String(error)}`,
        ),
      )
    } finally {
      setBusy(null)
    }
  }

  const runExport = async () => {
    setBusy('export')
    try {
      const path = await exportMarkerFile(fileFormat, coordinateFormat, {
        delimiter: csvDelimiter,
        includeDescription: csvColumns.description,
        includeFolder: csvColumns.folder,
        includeIcon: csvColumns.icon,
        includeColor: csvColumns.color,
      })
      if (path) {
        showToast(
          tx(
            `Экспортировано ${formatCount(markers.length)} меток: ${path}`,
            `Exported ${formatCount(markers.length)} markers: ${path}`,
          ),
        )
      }
    } catch (error) {
      showToast(
        tx(
          `Экспорт не удался: ${String(error)}`,
          `Export failed: ${String(error)}`,
        ),
      )
    } finally {
      setBusy(null)
    }
  }

  const flyTo = (id: string) => {
    setSelectedMarker(id)
    const marker = markers.find((item) => item.id === id)
    if (marker && map) {
      map.flyTo({
        center: [marker.lon, marker.lat],
        zoom: Math.max(map.getZoom(), 12),
        duration: 700,
      })
    }
  }

  return (
    <div className="inspector-body">
      <section className="section">
        <div className="section-heading">
          <span>
            {tx('Метки', 'Markers')} · {formatCount(filtered.length)}
            {filtered.length !== markers.length
              ? tx(
                  ` из ${formatCount(markers.length)}`,
                  ` of ${formatCount(markers.length)}`,
                )
              : ''}
          </span>
          <span className="mono">
            {placingMarker ? tx('режим метки', 'marker mode') : ''}
          </span>
        </div>
        <div className="marker-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => setPlacingMarker(!placingMarker)}
            aria-pressed={placingMarker}
          >
            <MapPin size={15} />
            {placingMarker
              ? tx('Готово', 'Done')
              : tx('Поставить', 'Place')}
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => void runImport()}
            disabled={!isNative || busy !== null}
            title={
              isNative
                ? tx('Импорт GeoJSON или CSV', 'Import GeoJSON or CSV')
                : tx(
                    'Доступно в нативном приложении',
                    'Available in the native app',
                  )
            }
          >
            {busy === 'import' ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Upload size={14} />
            )}
            {tx('Импорт', 'Import')}
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => void runExport()}
            disabled={!isNative || busy !== null || markers.length === 0}
            title={
              isNative
                ? tx('Экспорт всех меток', 'Export all markers')
                : tx(
                    'Доступно в нативном приложении',
                    'Available in the native app',
                  )
            }
          >
            {busy === 'export' ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <FileDown size={14} />
            )}
            {tx('Экспорт', 'Export')}
          </button>
        </div>
        <p className="settings-hint">
          {tx(
            'Клик по карте ставит метку, пока режим активен. Все метки хранятся локально и переживают перезапуск.',
            'Clicking the map places a marker while the mode is active. Markers are stored locally and survive restarts.',
          )}
        </p>
        <div className="marker-filter-grid">
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setVisibleCount(200)
            }}
            placeholder={tx(
              'Поиск по имени, описанию и папке…',
              'Search by name, description and folder…',
            )}
            aria-label={tx('Поиск меток', 'Search markers')}
          />
          <select
            value={folderFilter}
            onChange={(event) => {
              setFolderFilter(event.target.value)
              setVisibleCount(200)
            }}
            aria-label={tx('Фильтр по папке', 'Filter by folder')}
          >
            <option value="all">{tx('Все папки', 'All folders')}</option>
            <option value="none">{tx('Без папки', 'No folder')}</option>
            {folders.map((folder) => (
              <option key={folder} value={folder}>
                {folder}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="section">
        <div className="section-heading">
          <span>{tx('Система координат', 'Coordinate system')}</span>
        </div>
        <div className="marker-transfer-grid">
          <label className="marker-transfer-field">
            <span>{tx('Экспорт', 'Export')}</span>
            <select
              value={fileFormat}
              onChange={(event) =>
                setFileFormat(event.target.value as MarkerFileFormat)
              }
            >
              <option value="csv">CSV</option>
              <option value="geojson">GeoJSON</option>
              <option value="gpx">GPX</option>
              <option value="kml">KML</option>
              <option value="kmz">KMZ</option>
            </select>
          </label>
          <label className="marker-transfer-field">
            <span>{tx('Координаты', 'Coordinates')}</span>
            <select
              value={coordinateFormat}
              onChange={(event) =>
                setCoordinateFormat(
                  event.target.value as CoordinateFormat,
                )
              }
            >
              <option value="dd">
                WGS84 · {tx('градусы', 'degrees')}
              </option>
              <option value="dms">WGS84 · {tx('ГМС', 'DMS')}</option>
              <option value="utm">WGS84 · UTM</option>
              <option value="mgrs">WGS84 · MGRS</option>
            </select>
          </label>
        </div>
        {fileFormat === 'csv' && (
          <>
            <div className="marker-transfer-grid">
              <label className="marker-transfer-field">
                <span>{tx('Разделитель CSV', 'CSV separator')}</span>
                <select
                  value={csvDelimiter}
                  onChange={(event) => setCsvDelimiter(event.target.value)}
                >
                  <option value=";">
                    {tx('точка с запятой', 'semicolon')}
                  </option>
                  <option value=",">{tx('запятая', 'comma')}</option>
                  <option value={'\t'}>{tx('табуляция', 'tab')}</option>
                </select>
              </label>
            </div>
            <div
              className="csv-columns"
              role="group"
              aria-label={tx('Колонки CSV', 'CSV columns')}
            >
              {(
                [
                  ['description', tx('Описание', 'Description')],
                  ['folder', tx('Папка', 'Folder')],
                  ['icon', tx('Иконка', 'Icon')],
                  ['color', tx('Цвет', 'Colour')],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="csv-column">
                  <input
                    type="checkbox"
                    checked={csvColumns[key]}
                    onChange={(event) =>
                      setCsvColumns((columns) => ({
                        ...columns,
                        [key]: event.target.checked,
                      }))
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </>
        )}
        <p className="settings-hint">
          {tx(
            'GeoJSON, GPX и KML всегда WGS84. CSV использует выбранную систему: имя и координаты выгружаются всегда, остальные колонки включаются выше. Для UTM нужны zone, hemisphere, easting и northing; зона подбирается автоматически.',
            'GeoJSON, GPX and KML are always WGS84. CSV uses the selected system: name and coordinates are always written, other columns are toggled above. UTM needs zone, hemisphere, easting and northing; the zone is chosen automatically.',
          )}
        </p>
      </section>

      {markers.length === 0 ? (
        <section className="empty-state">
          <span className="empty-icon">
            <MapPin size={24} />
          </span>
          <h3>{tx('Пока нет меток', 'No markers yet')}</h3>
          <p>
            {tx(
              'Поставьте точку на карте или импортируйте CSV/GeoJSON из SAS.Planet, QGIS или полевого дневника.',
              'Place a point on the map or import CSV/GeoJSON from SAS.Planet, QGIS or a field notebook.',
            )}
          </p>
        </section>
      ) : (
        <>
          <div className="marker-list">
            {ordered.slice(0, visibleCount).map((marker, index, shown) => {
              const folder = marker.folder?.trim() ?? ''
              const previous = shown[index - 1]?.folder?.trim() ?? null
              const showFolder =
                folderFilter === 'all' && folder !== previous
              return (
                <Fragment key={marker.id}>
                  {showFolder && (
                    <div className="marker-folder">
                      {folder || tx('Без папки', 'No folder')}
                    </div>
                  )}
                  <div
                    className={`marker-row${marker.id === selectedMarkerId ? ' is-selected' : ''}`}
                    onClick={() => flyTo(marker.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') flyTo(marker.id)
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <span
                      className={`marker-dot${marker.icon ? ' has-icon' : ''}`}
                      style={
                        marker.color
                          ? { background: marker.color }
                          : undefined
                      }
                    >
                      {marker.icon}
                    </span>
                    <div className="marker-main">
                      <input
                        className="marker-name-input"
                        value={marker.name}
                        onClick={(event) => event.stopPropagation()}
                        onFocus={() => setSelectedMarker(marker.id)}
                        onKeyDown={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          updateMarker(marker.id, { name: event.target.value })
                        }
                        aria-label={tx(
                          `Название метки ${marker.name}`,
                          `Marker name ${marker.name}`,
                        )}
                      />
                      <span className="marker-coords">
                        {formatCoordinatePair(
                          marker.lon,
                          marker.lat,
                          coordinateFormat,
                        )}
                      </span>
                      {marker.description && (
                        <span className="marker-description">
                          {marker.description}
                        </span>
                      )}
                      {marker.id === selectedMarkerId && (
                        <div
                          className="marker-extras"
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <MarkerCoordinateEditor
                            marker={marker}
                            defaultFormat={coordinateFormat}
                            onApply={(lon, lat) => {
                              updateMarker(marker.id, { lon, lat })
                              map?.easeTo({
                                center: [lon, lat],
                                duration: 400,
                              })
                            }}
                          />
                          <span className="marker-style-caption">
                            {tx(
                              'Стиль точки: иконка и цвет',
                              'Point style: icon and colour',
                            )}
                          </span>
                          <input
                            value={marker.folder ?? ''}
                            onChange={(event) =>
                              updateMarker(marker.id, {
                                folder: event.target.value || undefined,
                              })
                            }
                            placeholder={tx('Папка', 'Folder')}
                            aria-label={tx('Папка метки', 'Marker folder')}
                          />
                          <select
                            value={marker.icon ?? ''}
                            onChange={(event) =>
                              updateMarker(marker.id, {
                                icon: event.target.value || undefined,
                              })
                            }
                            aria-label={tx('Иконка метки', 'Marker icon')}
                          >
                            <option value="">
                              ● {tx('метка', 'marker')}
                            </option>
                            <option value="📍">📍 {tx('точка', 'point')}</option>
                            <option value="🚩">🚩 {tx('флаг', 'flag')}</option>
                            <option value="⛺">
                              ⛺ {tx('стоянка', 'camp')}
                            </option>
                            <option value="🏠">🏠 {tx('дом', 'house')}</option>
                            <option value="💧">💧 {tx('вода', 'water')}</option>
                            <option value="⚓">
                              ⚓ {tx('причал', 'mooring')}
                            </option>
                            <option value="🚗">🚗 {tx('машина', 'car')}</option>
                            <option value="⭐">
                              ⭐ {tx('важное', 'important')}
                            </option>
                          </select>
                          <input
                            type="color"
                            value={marker.color ?? '#ff7a45'}
                            onChange={(event) =>
                              updateMarker(marker.id, {
                                color: event.target.value,
                              })
                            }
                            aria-label={tx('Цвет метки', 'Marker colour')}
                          />
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="icon-button pack-close"
                      onClick={(event) => {
                        event.stopPropagation()
                        removeMarker(marker.id)
                      }}
                      aria-label={tx(
                        `Удалить ${marker.name}`,
                        `Delete ${marker.name}`,
                      )}
                      title={tx('Удалить метку', 'Delete marker')}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </Fragment>
              )
            })}
            {filtered.length === 0 && (
              <p className="pack-empty">
                {tx('Метки не найдены.', 'No markers found.')}
              </p>
            )}
          </div>
          {filtered.length > visibleCount && (
            <button
              type="button"
              className="ghost-button"
              onClick={() => setVisibleCount((count) => count + 200)}
            >
              {tx('Показать ещё', 'Show more')}{' '}
              {formatCount(Math.min(200, filtered.length - visibleCount))}
            </button>
          )}
          <button
            type="button"
            className="ghost-button is-danger marker-clear"
            onClick={() => {
              if (
                window.confirm(
                  tx(
                    `Удалить все метки (${formatCount(markers.length)})?`,
                    `Delete all markers (${formatCount(markers.length)})?`,
                  ),
                )
              ) {
                clearMarkers()
              }
            }}
          >
            <Trash2 size={14} />
            {tx('Очистить все метки', 'Clear all markers')}
          </button>
        </>
      )}
    </div>
  )
}

function TrackPlayer({
  map,
  feature,
}: {
  map: MapLibreMap | null
  feature: MapFeature
}) {
  const tx = useText()
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(5)
  const [progress, setProgress] = useState(0)
  const progressRef = useRef(0)
  const markerRef = useRef<Marker | null>(null)
  const total = featureLength(feature)

  useEffect(() => {
    if (!map) return
    const element = document.createElement('div')
    element.className = 'track-player-marker'
    const marker = new Marker({ element, anchor: 'center' })
      .setLngLat(feature.coordinates[0] ?? [0, 0])
      .addTo(map)
    markerRef.current = marker
    return () => {
      marker.remove()
      markerRef.current = null
    }
    // The marker lives for the lifetime of the player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  useEffect(() => {
    if (!markerRef.current) return
    const point = pointAlongLine(feature.coordinates, progress)
    if (point) markerRef.current.setLngLat(point)
  }, [feature, progress])

  useEffect(() => {
    if (!playing) return
    let frame = 0
    let last = performance.now()
    const duration = 30_000 / speed
    const tick = (now: number) => {
      const elapsed = Math.min(250, now - last)
      last = now
      const next = Math.min(1, progressRef.current + elapsed / duration)
      progressRef.current = next
      setProgress(next)
      if (next >= 1) {
        setPlaying(false)
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, speed])

  const toggle = () => {
    if (!playing && progressRef.current >= 1) {
      progressRef.current = 0
      setProgress(0)
    }
    setPlaying((value) => !value)
  }

  return (
    <div className="track-player">
      <div className="section-heading">
        <span>{tx('Трек', 'Track')}</span>
        <span className="mono">
          {formatDistance(total * progress)} / {formatDistance(total)}
        </span>
      </div>
      <div className="track-player-controls">
        <button
          type="button"
          className="ghost-button track-player-toggle"
          onClick={toggle}
          aria-label={
            playing
              ? tx('Пауза воспроизведения', 'Pause playback')
              : tx('Воспроизвести трек', 'Play track')
          }
          aria-pressed={playing}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.001"
          value={progress}
          onChange={(event) => {
            const next = Number(event.target.value)
            progressRef.current = next
            setProgress(next)
            setPlaying(false)
          }}
          aria-label={tx('Позиция на треке', 'Track position')}
        />
        <select
          value={speed}
          onChange={(event) => setSpeed(Number(event.target.value))}
          aria-label={tx('Скорость воспроизведения', 'Playback speed')}
        >
          {[1, 2, 5, 10].map((value) => (
            <option key={value} value={value}>
              ×{value}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

function FeaturesPanel({ map }: { map: MapLibreMap | null }) {
  const tx = useText()
  const features = useAppStore((state) => state.features)
  const featureMode = useAppStore((state) => state.featureMode)
  const draftPoints = useAppStore((state) => state.draftPoints)
  const selectedFeatureId = useAppStore((state) => state.selectedFeatureId)
  const featureColor = useAppStore((state) => state.featureColor)
  const setFeatureMode = useAppStore((state) => state.setFeatureMode)
  const setFeatureColor = useAppStore((state) => state.setFeatureColor)
  const finishDraft = useAppStore((state) => state.finishDraft)
  const cancelDraft = useAppStore((state) => state.cancelDraft)
  const undoDraftPoint = useAppStore((state) => state.undoDraftPoint)
  const selectFeature = useAppStore((state) => state.selectFeature)
  const updateFeature = useAppStore((state) => state.updateFeature)
  const appendFeatureVertex = useAppStore((state) => state.appendFeatureVertex)
  const deleteFeatureVertex = useAppStore((state) => state.deleteFeatureVertex)
  const removeFeature = useAppStore((state) => state.removeFeature)
  const clearFeatures = useAppStore((state) => state.clearFeatures)
  const setSelection = useAppStore((state) => state.setSelection)
  const setSelectionPolygon = useAppStore((state) => state.setSelectionPolygon)
  const setDownloadOpen = useAppStore((state) => state.setDownloadOpen)
  const showToast = useAppStore((state) => state.showToast)
  const [busy, setBusy] = useState<'import' | 'export' | null>(null)

  const selected = features.find((item) => item.id === selectedFeatureId)
  const drawing =
    featureMode === 'draw-line' ||
    featureMode === 'draw-polygon' ||
    featureMode === 'draw-circle'
  const minimum =
    featureMode === 'draw-line' || featureMode === 'draw-circle' ? 2 : 3

  const startDraw = (
    mode: 'draw-line' | 'draw-polygon' | 'draw-circle',
  ) => {
    setFeatureMode(featureMode === mode ? 'off' : mode)
    showToast(
      mode === 'draw-line'
        ? tx(
            'Кликайте вершины линии. Enter — сохранить, Esc — отмена',
            'Click line vertices. Enter saves, Esc cancels',
          )
        : mode === 'draw-circle'
          ? tx(
              'Кликайте центр, затем край круга. Esc — отмена',
              'Click the centre, then the circle edge. Esc cancels',
            )
          : tx(
              'Кликайте вершины полигона. Enter — сохранить, Esc — отмена',
              'Click polygon vertices. Enter saves, Esc cancels',
            ),
    )
  }

  const downloadPolygon = (feature: MapFeature) => {
    const bounds = feature.coordinates.reduce<
      [[number, number], [number, number]]
    >(
      (box, point) => [
        [Math.min(box[0][0], point[0]), Math.min(box[0][1], point[1])],
        [Math.max(box[1][0], point[0]), Math.max(box[1][1], point[1])],
      ],
      [
        [Infinity, Infinity],
        [-Infinity, -Infinity],
      ],
    )
    setSelection(bounds)
    setSelectionPolygon(feature.coordinates)
    setDownloadOpen(true)
    showToast(tx('Полигон выбран для загрузки', 'Polygon selected for download'))
  }

  const fitFeature = (id: string) => {
    selectFeature(id)
    const target = features.find((item) => item.id === id)
    if (!target || !map) return
    const bounds = target.coordinates.reduce<
      [[number, number], [number, number]]
    >(
      (box, point) => [
        [Math.min(box[0][0], point[0]), Math.min(box[0][1], point[1])],
        [Math.max(box[1][0], point[0]), Math.max(box[1][1], point[1])],
      ],
      [
        [Infinity, Infinity],
        [-Infinity, -Infinity],
      ],
    )
    map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 650 })
  }

  const runImport = async () => {
    setBusy('import')
    try {
      const result = await importFeatureFile()
      if (!result) return
      if (result.features.length > 0) {
        showToast(
          tx(
            `Импортировано ${formatCount(result.features.length)} объектов` +
              (result.skipped > 0
                ? ` · пропущено ${formatCount(result.skipped)}`
                : ''),
            `Imported ${formatCount(result.features.length)} features` +
              (result.skipped > 0
                ? ` · ${formatCount(result.skipped)} skipped`
                : ''),
          ),
        )
      } else {
        showToast(
          tx(
            'В файле не найдено линий или полигонов',
            'No lines or polygons found in the file',
          ),
        )
      }
    } catch (error) {
      showToast(
        tx(
          `Импорт не удался: ${String(error)}`,
          `Import failed: ${String(error)}`,
        ),
      )
    } finally {
      setBusy(null)
    }
  }

  const runExport = async (format: 'geojson' | 'gpx' = 'geojson') => {
    setBusy('export')
    try {
      const path = await exportFeatureFile(format)
      if (path) {
        showToast(
          tx(
            `Экспортировано ${formatCount(features.length)} объектов: ${path}`,
            `Exported ${formatCount(features.length)} features: ${path}`,
          ),
        )
      }
    } catch (error) {
      showToast(
        tx(
          `Экспорт не удался: ${String(error)}`,
          `Export failed: ${String(error)}`,
        ),
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="inspector-body">
      <section className="section">
        <div className="section-heading">
          <span>
            {tx('Объекты', 'Features')} · {formatCount(features.length)}
          </span>
          <span className="mono">
            {featureMode === 'edit'
              ? tx('редактирование', 'editing')
              : drawing
                ? tx('рисование', 'drawing')
                : ''}
          </span>
        </div>
        <div className="marker-actions">
          <button
            type="button"
            className={`ghost-button${featureMode === 'draw-line' ? ' is-active' : ''}`}
            onClick={() => startDraw('draw-line')}
            aria-pressed={featureMode === 'draw-line'}
          >
            <Spline size={14} />
            {tx('Линия', 'Line')}
          </button>
          <button
            type="button"
            className={`ghost-button${featureMode === 'draw-polygon' ? ' is-active' : ''}`}
            onClick={() => startDraw('draw-polygon')}
            aria-pressed={featureMode === 'draw-polygon'}
          >
            <Pentagon size={14} />
            {tx('Полигон', 'Polygon')}
          </button>
          <button
            type="button"
            className={`ghost-button${featureMode === 'draw-circle' ? ' is-active' : ''}`}
            onClick={() => startDraw('draw-circle')}
            aria-pressed={featureMode === 'draw-circle'}
          >
            <Circle size={14} />
            {tx('Круг', 'Circle')}
          </button>
          <button
            type="button"
            className={`ghost-button${featureMode === 'edit' ? ' is-active' : ''}`}
            onClick={() => setFeatureMode(featureMode === 'edit' ? 'off' : 'edit')}
            aria-pressed={featureMode === 'edit'}
            title={tx(
              'Перетаскивайте точки, вершины линий и полигонов',
              'Drag points, line vertices and polygon vertices',
            )}
          >
            <PenLine size={14} />
            {tx('Правка', 'Edit')}
          </button>
        </div>

        {drawing && (
          <>
            <div className="marker-actions">
              <button
                type="button"
                className="primary-button"
                onClick={finishDraft}
                disabled={draftPoints.length < minimum}
              >
                {tx('Сохранить', 'Save')}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={undoDraftPoint}
                disabled={draftPoints.length === 0}
              >
                {tx('Точка назад', 'Undo point')}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={cancelDraft}
              >
                {tx('Отмена', 'Cancel')}
              </button>
            </div>
            <div className="marker-coords">
              {featureMode === 'draw-circle'
                ? tx('Круг: центр и радиус', 'Circle: centre and radius')
                : tx('Вершин:', 'Vertices:')}{' '}
              {featureMode === 'draw-circle'
                ? draftPoints.length >= 2
                  ? `${tx('радиус', 'radius')} ${formatDistance(
                      distance(draftPoints[0], draftPoints[1]),
                    )}`
                  : `${tx('минимум', 'minimum')} ${minimum}`
                : `${formatCount(draftPoints.length)} · ${tx('минимум', 'minimum')} ${minimum}`}
              {featureMode !== 'draw-circle' &&
                draftPoints.length >= 2 &&
                ` · ${formatDistance(pathLength(draftPoints))}`}
              {featureMode === 'draw-polygon' &&
                draftPoints.length >= 3 &&
                ` · ${formatArea(polygonArea(draftPoints))}`}
            </div>
          </>
        )}

        <div className="section-heading">
          <span>{tx('Цвет новых объектов', 'Colour for new features')}</span>
        </div>
        <div
          className="feature-colors"
          aria-label={tx('Цвет новых объектов', 'Colour for new features')}
        >
          {FEATURE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`feature-color${featureColor === color ? ' is-active' : ''}`}
              style={{ background: color }}
              onClick={() => {
                setFeatureColor(color)
                if (selected) updateFeature(selected.id, { color })
              }}
              aria-label={tx(`Цвет ${color}`, `Colour ${color}`)}
              aria-pressed={featureColor === color}
            />
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-heading">
          <span>GeoJSON / GPX</span>
          <span className="mono">WGS84</span>
        </div>
        <div className="marker-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => void runImport()}
            disabled={!isNative || busy !== null}
            title={
              isNative
                ? tx('Импорт GeoJSON', 'Import GeoJSON')
                : tx(
                    'Доступно в нативном приложении',
                    'Available in the native app',
                  )
            }
          >
            {busy === 'import' ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Upload size={14} />
            )}
            {tx('Импорт', 'Import')}
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => void runExport()}
            disabled={!isNative || busy !== null || features.length === 0}
            title={
              isNative
                ? tx('Экспорт GeoJSON', 'Export GeoJSON')
                : tx(
                    'Доступно в нативном приложении',
                    'Available in the native app',
                  )
            }
          >
            {busy === 'export' ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Save size={14} />
            )}
            {tx('Экспорт', 'Export')}
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => void runExport('gpx')}
            disabled={!isNative || busy !== null || features.length === 0}
            title={
              isNative
                ? tx(
                    'Экспорт треков GPX; полигоны станут замкнутыми треками',
                    'Export GPX tracks; polygons become closed tracks',
                  )
                : tx(
                    'Доступно в нативном приложении',
                    'Available in the native app',
                  )
            }
          >
            {busy === 'export' ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <FileDown size={14} />
            )}
            GPX
          </button>
        </div>
      </section>

      {selected && (
        <section className="section">
          <div className="section-heading">
            <span>{tx('Выбранный объект', 'Selected feature')}</span>
            <span className="mono">
              {selected.kind === 'line'
                ? tx('линия', 'line')
                : tx('полигон', 'polygon')}
            </span>
          </div>
          <input
            className="marker-name-input"
            value={selected.name}
            onChange={(event) =>
              updateFeature(selected.id, { name: event.target.value })
            }
            aria-label={tx('Название объекта', 'Feature name')}
          />
          <div className="marker-coords">
            {formatDistance(featureLength(selected))}
            {selected.kind === 'polygon' &&
              ` · ${formatArea(featureArea(selected))}`}
            {tx(
              ` · вершин ${formatCount(selected.coordinates.length)}`,
              ` · ${formatCount(selected.coordinates.length)} vertices`,
            )}
          </div>
          {selected.kind === 'line' && (
            <TrackPlayer
              key={selected.id}
              map={map}
              feature={selected}
            />
          )}
          <div className="section-heading">
            <span>
              {selected.kind === 'polygon'
                ? tx('Цвет полигона', 'Polygon colour')
                : tx('Цвет линии', 'Line colour')}
            </span>
            <span className="mono">{selected.color}</span>
          </div>
          <div
            className="feature-colors"
            aria-label={
              selected.kind === 'polygon'
                ? tx('Цвет полигона', 'Polygon colour')
                : tx('Цвет линии', 'Line colour')
            }
          >
            {FEATURE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`feature-color${selected.color === color ? ' is-active' : ''}`}
                style={{ background: color }}
                onClick={() => updateFeature(selected.id, { color })}
                aria-label={tx(`Цвет ${color}`, `Colour ${color}`)}
                aria-pressed={selected.color === color}
              />
            ))}
          </div>
          <div className="marker-actions">
            <button
              type="button"
              className="ghost-button"
              onClick={() => fitFeature(selected.id)}
            >
              <Eye size={14} />
              {tx('Показать', 'Show')}
            </button>
            {selected.kind === 'polygon' && (
              <button
                type="button"
                className="ghost-button"
                onClick={() => downloadPolygon(selected)}
              >
                <Download size={14} />
                {tx('Скачать', 'Download')}
              </button>
            )}
            <button
              type="button"
              className="ghost-button"
              onClick={() => appendFeatureVertex(selected.id)}
              title={tx(
                'Добавить вершину и перетащить её',
                'Add a vertex and drag it',
              )}
            >
              <Plus size={14} />
              {tx('Вершина', 'Vertex')}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() =>
                deleteFeatureVertex(
                  selected.id,
                  selected.coordinates.length - 1,
                )
              }
              disabled={
                selected.coordinates.length <=
                (selected.kind === 'line' ? 2 : 3)
              }
            >
              <X size={14} />
              {tx('Вершина', 'Vertex')}
            </button>
          </div>
          <div className="marker-actions">
            <button
              type="button"
              className="ghost-button is-danger"
              onClick={() => removeFeature(selected.id)}
            >
              <Trash2 size={14} />
              {tx('Удалить объект', 'Delete feature')}
            </button>
          </div>
        </section>
      )}

      {features.length > 0 && (
        <>
          <div className="marker-list">
            {features.map((feature) => (
              <div
                key={feature.id}
                className={`marker-row${feature.id === selectedFeatureId ? ' is-selected' : ''}`}
                onClick={() => fitFeature(feature.id)}
              >
                <span
                  className="feature-dot"
                  style={{ background: feature.color }}
                />
                <div className="marker-main">
                  <span className="marker-name">{feature.name}</span>
                  <span className="marker-coords">
                    {feature.kind === 'line'
                      ? tx('линия', 'line')
                      : tx('полигон', 'polygon')}{' '}
                    ·{' '}
                    {formatDistance(featureLength(feature))}
                    {feature.kind === 'polygon' &&
                      ` · ${formatArea(featureArea(feature))}`}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-button pack-close"
                  onClick={(event) => {
                    event.stopPropagation()
                    removeFeature(feature.id)
                  }}
                  aria-label={tx(
                    `Удалить ${feature.name}`,
                    `Delete ${feature.name}`,
                  )}
                  title={tx('Удалить объект', 'Delete feature')}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="ghost-button is-danger marker-clear"
            onClick={() => {
              if (
                window.confirm(
                  tx(
                    `Удалить все объекты (${formatCount(features.length)})?`,
                    `Delete all features (${formatCount(features.length)})?`,
                  ),
                )
              ) {
                clearFeatures()
              }
            }}
          >
            <Trash2 size={14} />
            {tx('Очистить все объекты', 'Clear all features')}
          </button>
        </>
      )}

      {features.length === 0 && !drawing && (
        <p className="hint-text">
          {tx(
            'Нарисуйте линию или полигон на карте. Объекты сохраняются автоматически и экспортируются в GeoJSON.',
            'Draw a line or polygon on the map. Features are saved automatically and can be exported to GeoJSON.',
          )}
        </p>
      )}
    </div>
  )
}

function ProjectsPanel({ map }: { map: MapLibreMap | null }) {
  const tx = useText()
  const locale = useAppStore((state) => state.locale)
  const projectName = useAppStore((state) => state.projectName)
  const projectPath = useAppStore((state) => state.projectPath)
  const setProjectMeta = useAppStore((state) => state.setProjectMeta)
  const markers = useAppStore((state) => state.markers)
  const features = useAppStore((state) => state.features)
  const packs = useAppStore((state) => state.packs)
  const recentProjects = useAppStore((state) => state.recentProjects)
  const clearRecentProjects = useAppStore(
    (state) => state.clearRecentProjects,
  )
  const showToast = useAppStore((state) => state.showToast)
  const autosaveEnabled = useAppStore((state) => state.autosaveEnabled)
  const setAutosaveEnabled = useAppStore(
    (state) => state.setAutosaveEnabled,
  )
  const [autosave, setAutosave] = useState<AutosaveSnapshot | null>(null)
  const [busy, setBusy] = useState<'save' | 'save-as' | 'open' | 'new' | null>(
    null,
  )

  useEffect(() => {
    if (!isNative) return
    let alive = true
    void readAutosave().then((slot) => {
      if (alive) setAutosave(slot)
    })
    return () => {
      alive = false
    }
  }, [])

  const runRestore = async () => {
    setBusy('open')
    try {
      const restored = await restoreAutosave(map)
      showToast(
        restored
          ? tx('Автосохранение восстановлено', 'Autosave restored')
          : tx('Автосохранение не найдено', 'No autosave found'),
      )
      if (restored) setAutosave(null)
    } catch (error) {
      showToast(
        tx(
          `Не удалось восстановить: ${String(error)}`,
          `Could not restore: ${String(error)}`,
        ),
      )
    } finally {
      setBusy(null)
    }
  }

  const runSave = async (saveAs: boolean) => {
    setBusy(saveAs ? 'save-as' : 'save')
    try {
      const result = await saveProjectFile({ saveAs, name: projectName })
      if (result)
        showToast(
          tx(
            `Проект сохранён: ${result.path}`,
            `Project saved: ${result.path}`,
          ),
        )
    } catch (error) {
      showToast(
        tx(
          `Не удалось сохранить проект: ${String(error)}`,
          `Could not save the project: ${String(error)}`,
        ),
      )
    } finally {
      setBusy(null)
    }
  }

  const runOpen = async () => {
    setBusy('open')
    try {
      const result = await openProjectFile(map)
      if (!result) return
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
    } catch (error) {
      showToast(
        tx(
          `Не удалось открыть проект: ${String(error)}`,
          `Could not open the project: ${String(error)}`,
        ),
      )
    } finally {
      setBusy(null)
    }
  }

  const runOpenPath = async (path: string) => {
    setBusy('open')
    try {
      const result = await openProjectPath(path, map)
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
    } catch (error) {
      showToast(
        tx(
          `Не удалось открыть проект: ${String(error)}`,
          `Could not open the project: ${String(error)}`,
        ),
      )
    } finally {
      setBusy(null)
    }
  }

  const runNew = async () => {
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
    setBusy('new')
    try {
      await newProject(map)
      showToast(tx('Новый проект создан', 'New project created'))
    } catch (error) {
      showToast(
        tx(
          `Не удалось создать проект: ${String(error)}`,
          `Could not create the project: ${String(error)}`,
        ),
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="inspector-body">
      <section className="section">
        <div className="section-heading">
          <span>{tx('Текущий проект', 'Current project')}</span>
          <span className="pack-meta">
            {tx(
              `${markers.length} меток · ${features.length} объектов · ${packs.length} паков`,
              `${markers.length} markers · ${features.length} features · ${packs.length} packs`,
            )}
          </span>
        </div>
        <div className="source-form">
          <label>
            {tx('Название', 'Name')}
            <input
              value={projectName}
              onChange={(event) =>
                setProjectMeta(event.target.value, projectPath)
              }
              placeholder={tx('Мой проект', 'My project')}
            />
          </label>
          <span className="source-hint">
            {projectPath ??
              tx(
                'Проект ещё не сохранён на диск',
                'The project has not been saved to disk yet',
              )}
          </span>
          <div className="marker-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => void runSave(false)}
              disabled={busy !== null}
            >
              {busy === 'save' ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Save size={14} />
              )}
              {tx('Сохранить', 'Save')}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => void runSave(true)}
              disabled={busy !== null}
            >
              {busy === 'save-as' ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <FileDown size={14} />
              )}
              {tx('Сохранить как…', 'Save as…')}
            </button>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-heading">
          <span>{tx('Автосохранение', 'Autosave')}</span>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={autosaveEnabled}
              onChange={(event) => setAutosaveEnabled(event.target.checked)}
            />
            <span>{tx('Включено', 'Enabled')}</span>
          </label>
        </div>
        <p className="settings-hint">
          {tx(
            'Через 12 секунд после правок рабочая область записывается в резервный слот. Файл проекта не перезаписывается.',
            'Twelve seconds after an edit the workspace is written to a recovery slot. The project file is never overwritten.',
          )}
        </p>
        {autosave ? (
          <div className="recent-row autosave-row">
            <Clock3 size={14} />
            <span className="recent-main">
              <strong>{autosave.project.name}</strong>
              <span>
                {new Date(autosave.project.savedAt).toLocaleString(locale)} ·{' '}
                {tx(
                  `${autosave.project.markers.length} меток · ${autosave.project.vectorLayers.length} слоёв`,
                  `${autosave.project.markers.length} markers · ${autosave.project.vectorLayers.length} layers`,
                )}
              </span>
            </span>
            <button
              type="button"
              className="ghost-button"
              onClick={() => void runRestore()}
              disabled={busy !== null}
            >
              {tx('Восстановить', 'Restore')}
            </button>
          </div>
        ) : (
          <p className="pack-empty">
            {tx(
              'Резервная копия ещё не создана.',
              'No recovery copy has been created yet.',
            )}
          </p>
        )}
      </section>

      {recentProjects.length > 0 && (
        <section className="section">
          <div className="section-heading">
            <span>{tx('Недавние проекты', 'Recent projects')}</span>
            <button
              type="button"
              className="ghost-button"
              onClick={clearRecentProjects}
            >
              <Trash2 size={13} />
              {tx('Очистить', 'Clear')}
            </button>
          </div>
          <div className="recent-list">
            {recentProjects.map((project) => (
              <button
                key={project.path}
                type="button"
                className="recent-row"
                onClick={() => void runOpenPath(project.path)}
                disabled={busy !== null}
                title={project.path}
              >
                <FolderOpen size={14} />
                <span className="recent-main">
                  <strong>{project.name}</strong>
                  <span>{project.path}</span>
                </span>
                <span className="recent-date">
                  {new Date(project.at).toLocaleDateString(locale)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="section-heading">
          <span>{tx('Файл проекта', 'Project file')}</span>
        </div>
        <div className="marker-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void runOpen()}
            disabled={busy !== null}
          >
            {busy === 'open' ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <FolderOpen size={14} />
            )}
            {tx('Открыть…', 'Open…')}
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => void runNew()}
            disabled={busy !== null}
          >
            {busy === 'new' ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Plus size={14} />
            )}
            {tx('Новый', 'New')}
          </button>
        </div>
        <p className="source-hint">
          {tx(
            'В проект входят подложка, вид карты, слои, метки, линии и полигоны, открытые паки, формат координат и CRS. Свои источники и их ключи хранятся отдельно и в файл не попадают.',
            'A project contains the basemap, map view, layers, markers, lines and polygons, open packs, coordinate format and CRS. Custom sources and their keys are stored separately and never enter the file.',
          )}
        </p>
      </section>
    </div>
  )
}

function SettingsPanel() {
  const t = useT()
  const tx = useText()
  const locale = useAppStore((state) => state.locale)
  const setLocale = useAppStore((state) => state.setLocale)
  const showToast = useAppStore((state) => state.showToast)
  const packLicense = useAppStore((state) => state.packLicense)
  const setPackLicense = useAppStore((state) => state.setPackLicense)
  const crs = useAppStore((state) => state.crs)
  const crsLabel = useAppStore((state) => state.crsLabel)
  const setCrs = useAppStore((state) => state.setCrs)
  const [cache, setCache] = useState<NativeCacheStats | null>(null)
  const [providerCache, setProviderCache] = useState<ProviderCacheStats[]>([])
  const [file, setFile] = useState<string | null>(null)
  const [limitMb, setLimitMb] = useState(2048)
  const [proxy, setProxy] = useState('')
  const [busy, setBusy] = useState(false)
  const [presets, setPresets] = useState<CrsPreset[]>([])
  const [crsChoice, setCrsChoice] = useState('wgs84')
  const [customProj, setCustomProj] = useState('')
  const [crsBusy, setCrsBusy] = useState(false)
  const [logBusy, setLogBusy] = useState(false)
  const [cacheBusy, setCacheBusy] = useState(false)
  const mapView = useViewStore((state) => state.mapView)
  const [lon, lat] = mapView.center
  const convergence = meridianConvergence(lon, lat)
  const scale = pointScaleFactor(lon, lat)
  const magnetic = magneticField(lon, lat)
  const mgrs = lonLatToMgrs(lon, lat)

  useEffect(() => {
    if (!isNative) return
    void crsPresets().then(setPresets)
  }, [])

  useEffect(() => {
    // Mirror the persisted CRS into the local form fields.
    // oxlint-disable react/set-state-in-effect
    if (crs?.epsg) {
      setCrsChoice(String(crs.epsg))
      setCustomProj('')
    } else if (crs?.proj) {
      setCrsChoice('custom')
      setCustomProj(crs.proj)
    } else {
      setCrsChoice('wgs84')
      setCustomProj('')
    }
    // oxlint-enable react/set-state-in-effect
  }, [crs])

  const applyCrs = async () => {
    if (!isNative) return
    if (crsChoice === 'wgs84') {
      setCrs(null, '')
      showToast(tx('Координаты: WGS84 DD/DMS/UTM', 'Coordinates: WGS84 DD/DMS/UTM'))
      return
    }
    setCrsBusy(true)
    try {
      if (crsChoice === 'custom') {
        const proj = customProj.trim()
        if (!proj.startsWith('+')) {
          throw new Error(
            tx(
              'proj4-строка должна начинаться с «+»',
              'the proj4 string must start with “+”',
            ),
          )
        }
        await transformPoints({ epsg: 4326 }, { proj }, [[37.6, 55.7]])
        setCrs({ proj }, tx('Своя СК (proj4)', 'Custom CRS (proj4)'))
        showToast(
          tx(
            'Пользовательская СК применена',
            'Custom coordinate system applied',
          ),
        )
      } else {
        const epsg = Number(crsChoice)
        const preset = presets.find((item) => item.epsg === epsg)
        await transformPoints({ epsg: 4326 }, { epsg }, [[37.6, 55.7]])
        setCrs({ epsg }, preset?.label ?? `EPSG:${epsg}`)
        showToast(
          tx(
            `Координаты: ${preset?.label ?? `EPSG:${epsg}`}`,
            `Coordinates: ${preset?.label ?? `EPSG:${epsg}`}`,
          ),
        )
      }
    } catch (error) {
      showToast(
        tx(
          `Не удалось применить СК: ${String(error)}`,
          `Could not apply the coordinate system: ${String(error)}`,
        ),
      )
    } finally {
      setCrsBusy(false)
    }
  }

  const validateCrs = async () => {
    const spec = crs ?? { epsg: 32637 as const }
    const label = crs ? crsLabel : 'WGS84 / UTM 37N'
    const samples: [number, number][] = [
      [37.6173, 55.7558],
      [34.1, 44.95],
      [30.3, 59.9],
    ]
    setCrsBusy(true)
    try {
      let worst = 0
      for (const sample of samples) {
        const [projected] = await transformPoints(
          { epsg: 4326 },
          spec,
          [sample],
        )
        const [back] = await transformPoints(spec, { epsg: 4326 }, [projected])
        worst = Math.max(worst, distance(sample, back))
      }
      showToast(
        tx(
          `Круговой контроль «${label}»: максимум ${worst.toFixed(3)} м`,
          `Round-trip check “${label}”: worst case ${worst.toFixed(3)} m`,
        ),
      )
    } catch (error) {
      showToast(
        tx(
          `Контроль СК не пройден: ${String(error)}`,
          `Coordinate system check failed: ${String(error)}`,
        ),
      )
    } finally {
      setCrsBusy(false)
    }
  }

  const refresh = useCallback(async () => {
    const [stats, byProvider, path, current] = await Promise.all([
      cacheStats(),
      cacheStatsByProvider(),
      cachePath(),
      getSettings(),
    ])
    setCache(stats)
    setProviderCache(byProvider)
    setFile(path)
    if (current) {
      setLimitMb(Math.round(current.cacheLimitBytes / MIB))
      setProxy(current.proxy ?? '')
    }
  }, [])

  useEffect(() => {
    // Stats arrive asynchronously; this is not a render loop.
    // oxlint-disable-next-line react/set-state-in-effect
    if (isNative) void refresh()
  }, [refresh])

  const languageSection = (
    <section className="section">
      <div className="section-heading">
        <span>{t('settings.language')}</span>
        <Globe2 size={13} />
      </div>
      <div className="settings-field">
        <select
          className="settings-input"
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
          aria-label={t('settings.language')}
        >
          <option value="ru">Русский</option>
          <option value="en">English</option>
        </select>
      </div>
      <p className="settings-hint">{t('settings.languageHint')}</p>
    </section>
  )

  if (!isNative) {
    return (
      <div className="inspector-body">
        {languageSection}
        <section className="empty-state">
          <span className="empty-icon">
            <Settings2 size={24} />
          </span>
          <h3>
            {tx('Настройки нативного приложения', 'Native app settings')}
          </h3>
          <p>
            {tx(
              'Дисковый кэш, лимит хранения и прокси доступны в приложении Mappa. В браузере эти настройки не применяются.',
              'Disk cache, storage limits and the proxy are available in the Mappa app. These settings do not apply in the browser.',
            )}
          </p>
        </section>
      </div>
    )
  }

  const settings: NativeSettings = {
    cacheLimitBytes: Math.round(limitMb * MIB),
    proxy: proxy.trim() || null,
  }

  const save = async () => {
    if (busy) return
    if (!Number.isFinite(limitMb) || limitMb < 64) {
      showToast(
        tx('Минимальный лимит кэша — 64 МБ', 'The minimum cache limit is 64 MB'),
      )
      return
    }
    setBusy(true)
    try {
      const applied = await updateSettings(settings)
      setLimitMb(Math.round(applied.cacheLimitBytes / MIB))
      setProxy(applied.proxy ?? '')
      showToast(tx('Настройки сохранены', 'Settings saved'))
      await refresh()
    } catch (error) {
      showToast(
        tx(
          `Не удалось сохранить: ${String(error)}`,
          `Could not save: ${String(error)}`,
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  const checkCache = async () => {
    setCacheBusy(true)
    try {
      const report = await verifyCache(true)
      showToast(
        report.corrupt === 0
          ? tx(
              `Кэш целостен: проверено ${formatCount(report.checked)} тайлов`,
              `Cache is intact: checked ${formatCount(report.checked)} tiles`,
            )
          : tx(
              `Удалено ${formatCount(report.removed)} битых тайлов из ${formatCount(report.checked)} (${formatBytes(report.bytes)})`,
              `Removed ${formatCount(report.removed)} damaged tiles out of ${formatCount(report.checked)} (${formatBytes(report.bytes)})`,
            ),
      )
      await refresh()
    } catch (error) {
      showToast(
        tx(
          `Проверка кэша не удалась: ${String(error)}`,
          `Cache check failed: ${String(error)}`,
        ),
      )
    } finally {
      setCacheBusy(false)
    }
  }

  const wipe = async () => {
    if (
      !window.confirm(
        tx(
          'Удалить все тайлы из дискового кэша? Скачанные паки и очередь загрузок останутся.',
          'Delete every tile from the disk cache? Downloaded packs and the download queue will remain.',
        ),
      )
    ) {
      return
    }
    setBusy(true)
    try {
      const removed = await clearCache()
      showToast(
        tx(
          `Кэш очищен: ${formatCount(removed)} тайлов`,
          `Cache cleared: ${formatCount(removed)} tiles`,
        ),
      )
      await refresh()
    } catch (error) {
      showToast(
        tx(
          `Не удалось очистить: ${String(error)}`,
          `Could not clear the cache: ${String(error)}`,
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="inspector-body">
      <section className="card settings-card">
        <div className="card-heading">
          <span className="card-icon">
            <HardDrive size={15} />
          </span>
          <div>
            <span className="eyebrow">{tx('Кэш тайлов', 'Tile cache')}</span>
            <strong>
              {cache
                ? tx(
                    `${formatBytes(cache.bytes)} · ${formatCount(cache.tiles)} тайлов`,
                    `${formatBytes(cache.bytes)} · ${formatCount(cache.tiles)} tiles`,
                  )
                : 'SQLite WAL'}
            </strong>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => void refresh()}
            aria-label={tx('Обновить статистику', 'Refresh statistics')}
            title={tx('Обновить', 'Refresh')}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        {file && (
          <p className="path-readout mono" title={file}>
            {file}
          </p>
        )}
        {cache && (
          <p>
            {tx(
              `Попадания ${formatCount(cache.hits)} · промахи ${formatCount(cache.misses)}. Старые тайлы вытесняются автоматически, когда кэш превышает лимит.`,
              `Hits ${formatCount(cache.hits)} · misses ${formatCount(cache.misses)}. Old tiles are evicted automatically when the cache exceeds its limit.`,
            )}
          </p>
        )}
      </section>

      {providerCache.length > 0 && (
        <section className="section">
          <div className="section-heading">
            <span>{tx('Кэш по источникам', 'Cache by source')}</span>
            <Database size={13} />
          </div>
          <div className="coverage-controls">
            <span className="coverage-source">{tx('Всего', 'Total')}</span>
            <span className="mono">
              {formatBytes(providerCache.reduce((sum, item) => sum + item.bytes, 0))}
            </span>
          </div>
          {providerCache.map((item) => (
            <div className="coverage-controls" key={item.providerId}>
              <span className="coverage-source">
                {PROVIDERS.find((provider) => provider.id === item.providerId)
                  ?.label ?? item.providerId}
              </span>
              <span className="mono">
                {formatBytes(item.bytes)} · {formatCount(item.tiles)}
              </span>
            </div>
          ))}
          <p className="settings-hint">
            {tx(
              'Объём кэша по каждой подложке и своему источнику. Очистка выполняется общей кнопкой ниже.',
              'Cache size per basemap and custom source. Clearing is done with the shared button below.',
            )}
          </p>
        </section>
      )}

      {languageSection}

      <section className="section">
        <div className="section-heading">
          <span>{tx('Лимит на диске', 'Disk limit')}</span>
          <span className="mono">{formatBytes(settings.cacheLimitBytes)}</span>
        </div>
        <div className="settings-field">
          <input
            type="range"
            min="64"
            max="16384"
            step="64"
            value={Math.min(16384, Math.max(64, limitMb))}
            onChange={(event) => setLimitMb(Number(event.target.value))}
            aria-label={tx('Лимит кэша в мегабайтах', 'Cache limit in megabytes')}
          />
          <label className="settings-number">
            <input
              type="number"
              min="64"
              step="64"
              value={limitMb}
              onChange={(event) => setLimitMb(Number(event.target.value))}
              aria-label={tx('Лимит кэша, МБ', 'Cache limit, MB')}
            />
            <span>{tx('МБ', 'MB')}</span>
          </label>
        </div>
        <p className="settings-hint">
          {tx(
            'Минимум 64 МБ. При снижении лимита лишние тайлы удаляются сразу после сохранения.',
            'Minimum 64 MB. When the limit is lowered, excess tiles are removed right after saving.',
          )}
        </p>
      </section>

      <section className="section">
        <div className="section-heading">
          <span>{tx('Прокси', 'Proxy')}</span>
          <Network size={13} />
        </div>
        <div className="settings-field">
          <input
            type="url"
            className="settings-input"
            placeholder="http://127.0.0.1:3128"
            value={proxy}
            onChange={(event) => setProxy(event.target.value)}
            aria-label={tx('HTTP-прокси', 'HTTP proxy')}
          />
        </div>
        <p className="settings-hint">
          {tx(
            'Поддерживаются http и https. Пустое поле — прямое подключение. Новый прокси применяется к следующим запросам без перезапуска.',
            'HTTP and HTTPS are supported. An empty field means a direct connection. A new proxy applies to subsequent requests without a restart.',
          )}
        </p>
      </section>

      <section className="section">
        <div className="section-heading">
          <span>{tx('Лицензия паков', 'Pack licence')}</span>
          <FileDown size={13} />
        </div>
        <div className="settings-field">
          <input
            type="text"
            className="settings-input"
            placeholder="ODbL-1.0, CC-BY-4.0, public-domain…"
            value={packLicense}
            onChange={(event) => setPackLicense(event.target.value)}
            aria-label={tx(
              'Лицензия данных для экспортируемых паков',
              'Data licence for exported packs',
            )}
          />
        </div>
        <p className="settings-hint">
          {tx(
            'Записывается в метаданные MBTiles/PMTiles и в подписанный manifest.json (SHA-256 + Ed25519).',
            'Written to MBTiles/PMTiles metadata and to a signed manifest.json (SHA-256 + Ed25519).',
          )}
        </p>
      </section>

      <section className="section">
        <div className="section-heading">
          <span>{tx('Система координат', 'Coordinate system')}</span>
          <Globe2 size={13} />
        </div>
        <div className="settings-field">
          <select
            className="settings-input"
            value={crsChoice}
            onChange={(event) => setCrsChoice(event.target.value)}
            aria-label={tx('Система координат', 'Coordinate system')}
          >
            <option value="wgs84">WGS84 · DD/DMS/UTM</option>
            {presets.map((preset) => (
              <option key={preset.epsg} value={preset.epsg}>
                EPSG:{preset.epsg} · {preset.label} ({preset.units})
              </option>
            ))}
            <option value="custom">
              {tx('Своя proj4-строка…', 'Custom proj4 string…')}
            </option>
          </select>
        </div>
        {crsChoice === 'custom' && (
          <div className="settings-field">
            <textarea
              className="settings-input"
              rows={3}
              value={customProj}
              onChange={(event) => setCustomProj(event.target.value)}
              placeholder="+proj=tmerc +lat_0=0 +lon_0=39 +k=1 +x_0=7500000 +y_0=0 +ellps=krass +towgs84=..."
              spellCheck={false}
              aria-label={tx('proj4-строка', 'proj4 string')}
            />
          </div>
        )}
        <div className="settings-field">
          <button
            type="button"
            className="ghost-button"
            onClick={() => void applyCrs()}
            disabled={crsBusy}
          >
            {crsBusy ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Globe2 size={14} />
            )}
            {tx('Применить СК', 'Apply CRS')}
          </button>
          {crs && <span className="mono">{crsLabel}</span>}
        </div>
        <p className="settings-hint">
          {tx(
            'Координаты в статус-баре и переход по координатам используют эту систему. Проекции считаются офлайн через PROJ-совместимый движок. Для локальных систем задайте proj4-строку с параметрами датума.',
            'Coordinates in the status bar and coordinate navigation use this system. Projections are computed offline by a PROJ-compatible engine. For local systems, provide a proj4 string with datum parameters.',
          )}
        </p>
        <button
          type="button"
          className="ghost-button"
          onClick={() => void validateCrs()}
          disabled={crsBusy}
        >
          {tx('Круговой контроль СК', 'CRS round-trip check')}
        </button>
      </section>

      <section className="section">
        <div className="section-heading">
          <span>{tx('Геодезия в центре карты', 'Geodesy at map centre')}</span>
          <Globe2 size={13} />
        </div>
        <div className="geodesy-grid mono">
          <span>MGRS</span>
          <strong>{mgrs ?? '—'}</strong>
          <span>{tx('Сближение меридианов', 'Meridian convergence')}</span>
          <strong>{convergence.toFixed(3)}°</strong>
          <span>{tx('Масштаб сетки UTM', 'UTM grid scale')}</span>
          <strong>{scale.toFixed(6)}</strong>
          <span>{tx('Магнитное склонение', 'Magnetic declination')}</span>
          <strong>
            {magnetic.declination >= 0 ? '+' : ''}
            {magnetic.declination.toFixed(2)}°
          </strong>
          <span>{tx('Модель', 'Model')}</span>
          <strong>WMM2025 · 2025–2030</strong>
        </div>
        <p className="settings-hint">
          {tx(
            'Сближение и масштаб рассчитаны для ближайшей зоны UTM (та же математика, что у СК-42/МСК). Склонение — по WMM2025; для полевых работ сверяйте с официальным бюллетенем.',
            'Convergence and scale use the nearest UTM zone (the same mathematics as SK-42/MSK). Declination follows WMM2025; for field work verify it against the official bulletin.',
          )}
        </p>
      </section>

      <section className="section">
        <div className="section-heading">
          <span>{tx('Журнал', 'Log')}</span>
          <span className="mono">MAPPA_LOG</span>
        </div>
        <p className="settings-hint">
          {tx(
            'Диагностика пишется в журнал приложения. Уровень задаётся переменной окружения MAPPA_LOG=debug перед запуском.',
            'Diagnostics are written to the application log. Set MAPPA_LOG=debug in the environment before launch to change the level.',
          )}
        </p>
        <button
          type="button"
          className="ghost-button"
          disabled={logBusy}
          onClick={() => {
            setLogBusy(true)
            void openLogDirectory()
              .then((path) => showToast(tx(`Журнал: ${path}`, `Log: ${path}`)))
              .catch((error: unknown) =>
                showToast(
                  tx(
                    `Не удалось открыть журнал: ${String(error)}`,
                    `Could not open the log: ${String(error)}`,
                  ),
                ),
              )
              .finally(() => setLogBusy(false))
          }}
        >
          {logBusy ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <FolderOpen size={14} />
          )}
          {tx('Открыть папку журнала', 'Open log folder')}
        </button>
      </section>

      <div className="settings-actions">
        <button
          type="button"
          className="primary-button"
          onClick={() => void save()}
          disabled={busy}
        >
          {busy ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <Save size={15} />
          )}
          {tx('Сохранить', 'Save')}
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={() => void checkCache()}
          disabled={cacheBusy || busy}
        >
          {cacheBusy ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          {tx('Проверить и починить', 'Check and repair')}
        </button>
        <button
          type="button"
          className="ghost-button is-danger"
          onClick={() => void wipe()}
          disabled={busy}
        >
          <Trash2 size={14} />
          {tx('Очистить кэш', 'Clear cache')}
        </button>
      </div>
    </div>
  )
}

export function Inspector({ map }: { map: MapLibreMap | null }) {
  const t = useT()
  const tx = useText()
  const panel = useAppStore((state) => state.panel)
  const setPanel = useAppStore((state) => state.setPanel)
  const providerId = useAppStore((state) => state.providerId)
  const layers = useAppStore((state) => state.layers)
  const packs = useAppStore((state) => state.packs)
  const toggleLayer = useAppStore((state) => state.toggleLayer)
  const setLayerOpacity = useAppStore((state) => state.setLayerOpacity)
  const customSources = useAppStore((state) => state.customSources)
  const customLayers = useAppStore((state) => state.customLayers)
  const setCustomSources = useAppStore((state) => state.setCustomSources)
  const toggleCustomLayer = useAppStore((state) => state.toggleCustomLayer)
  const setCustomLayerOpacity = useAppStore(
    (state) => state.setCustomLayerOpacity,
  )
  const togglePack = useAppStore((state) => state.togglePack)
  const setPackOpacity = useAppStore((state) => state.setPackOpacity)
  const vectorLayers = useAppStore((state) => state.vectorLayers)
  const removeVectorLayer = useAppStore((state) => state.removeVectorLayer)
  const toggleVectorLayer = useAppStore((state) => state.toggleVectorLayer)
  const setVectorLayerOpacity = useAppStore(
    (state) => state.setVectorLayerOpacity,
  )
  const setVectorLayerStyle = useAppStore(
    (state) => state.setVectorLayerStyle,
  )
  const setFeatureMode = useAppStore((state) => state.setFeatureMode)
  const selectVectorFeature = useAppStore(
    (state) => state.selectVectorFeature,
  )
  const snapping = useAppStore((state) => state.snapping)
  const toggleSnapping = useAppStore((state) => state.toggleSnapping)
  const mapGrid = useAppStore((state) => state.mapGrid)
  const toggleMapGrid = useAppStore((state) => state.toggleMapGrid)
  const setDownloadOpen = useAppStore((state) => state.setDownloadOpen)
  const showToast = useAppStore((state) => state.showToast)

  const coverageVisible = useCoverageStore((state) => state.visible)
  const coverageTiles = useCoverageStore((state) => state.tiles)
  const coverageTruncated = useCoverageStore((state) => state.truncated)
  const coverageBusy = useCoverageStore((state) => state.busy)
  const coverageError = useCoverageStore((state) => state.error)
  const setCoverageVisible = useCoverageStore((state) => state.setVisible)
  const refreshCoverage = useCoverageStore((state) => state.refresh)

  const jobs = useDownloadsStore((state) => state.jobs)
  const pause = useDownloadsStore((state) => state.pause)
  const resume = useDownloadsStore((state) => state.resume)
  const cancel = useDownloadsStore((state) => state.cancel)
  const remove = useDownloadsStore((state) => state.remove)
  const clearFinished = useDownloadsStore((state) => state.clearFinished)
  const exportJob = useDownloadsStore((state) => state.exportJob)
  const packLicense = useAppStore((state) => state.packLicense)
  const [cache, setCache] = useState<NativeCacheStats | null>(null)
  const [sourceForm, setSourceForm] = useState(false)
  const [sourceBusy, setSourceBusy] = useState(false)
  const [sourceDraft, setSourceDraft] = useState<CustomSourceDraft>({
    name: '',
    kind: 'xyz',
    url: '',
    scheme: 'xyz',
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    format: 'png',
    attribution: '',
    headers: {},
    rps: 4,
    burst: 8,
    offlineAllowed: false,
  })
  const [headerText, setHeaderText] = useState('')
  const [wmtsLayers, setWmtsLayers] = useState<WmtsLayer[]>([])
  const [wmtsBusy, setWmtsBusy] = useState(false)
  const [attributeLayerId, setAttributeLayerId] = useState<string | null>(null)
  const [attributeQuery, setAttributeQuery] = useState('')
  const [gpkgPicker, setGpkgPicker] = useState<{
    layers: GeoPackageLayer[]
    resolve: (layer: string | null) => void
  } | null>(null)
  const [mapExportBusy, setMapExportBusy] = useState<MapExportFormat | null>(
    null,
  )
  const [exportGrid, setExportGrid] = useState(true)
  const [exportLegend, setExportLegend] = useState(true)
  const attributeDialogRef = useRef<HTMLDivElement | null>(null)
  const gpkgDialogRef = useRef<HTMLDivElement | null>(null)
  useDialogFocus(
    attributeDialogRef,
    () => setAttributeLayerId(null),
    attributeLayerId !== null,
  )
  useDialogFocus(
    gpkgDialogRef,
    () => {
      gpkgPicker?.resolve(null)
      setGpkgPicker(null)
    },
    gpkgPicker !== null,
  )

  useEffect(() => {
    if (panel !== 'layers' || !isNative) return
    let alive = true
    void cacheStats().then((stats) => {
      if (alive) setCache(stats)
    })
    return () => {
      alive = false
    }
  }, [panel])

  if (!panel) return null

  const provider = providerById(providerId)
  const finished = jobs.filter(
    (job) => job.status === 'completed' || job.status === 'cancelled',
  ).length

  const runAction = async (
    job: DownloadJob,
    action: 'pause' | 'resume' | 'cancel' | 'delete',
  ) => {
    if (
      (action === 'cancel' || action === 'delete') &&
      !window.confirm(
        action === 'cancel'
          ? tx(
              `Отменить «${job.name}»? Скачанные тайлы останутся в кэше.`,
              `Cancel “${job.name}”? Downloaded tiles will remain in the cache.`,
            )
          : tx(
              `Удалить «${job.name}» из очереди? Тайлы останутся в кэше.`,
              `Remove “${job.name}” from the queue? Tiles will remain in the cache.`,
            ),
      )
    ) {
      return
    }
    try {
      if (action === 'pause') await pause(job.id)
      else if (action === 'resume') await resume(job.id)
      else if (action === 'cancel') await cancel(job.id)
      else await remove(job.id)
    } catch (error) {
      showToast(tx(`Не удалось: ${String(error)}`, `Failed: ${String(error)}`))
    }
  }

  const refreshSources = async () => {
    const list = await listCustomSources()
    setCustomSources(list)
  }

  const hasXyzTokens = (url: string) =>
    /\{z\}/.test(url) &&
    /\{x\}/.test(url) &&
    (/\{y\}/.test(url) || /\{-y\}/.test(url))

  const applyWmtsLayer = (layer: WmtsLayer) => {
    setSourceDraft((draft) => ({
      ...draft,
      kind: 'wmts',
      scheme: 'xyz',
      name: draft.name.trim() ? draft.name : layer.title,
      url: layer.url,
      minZoom: layer.minZoom,
      maxZoom: layer.maxZoom,
      tileSize: layer.tileSize,
      format: layer.format,
      attribution: draft.attribution.trim() ? draft.attribution : layer.title,
    }))
    setWmtsLayers([])
  }

  const loadWmtsLayers = async () => {
    if (!sourceDraft.url.trim()) {
      showToast(tx('Укажите URL GetCapabilities', 'Provide a GetCapabilities URL'))
      return
    }
    setWmtsBusy(true)
    try {
      const document = await wmtsCapabilities(
        sourceDraft.url.trim(),
        parseHeaders(headerText),
        sourceDraft.id,
      )
      if (document.layers.length === 1) {
        applyWmtsLayer(document.layers[0])
        showToast(
          tx(
            `Слой добавлен: ${document.layers[0].title}`,
            `Layer added: ${document.layers[0].title}`,
          ),
        )
      } else {
        setWmtsLayers(document.layers)
        showToast(
          tx(
            `Найдено слоёв: ${document.layers.length}. Выберите нужный.`,
            `Layers found: ${document.layers.length}. Choose one.`,
          ),
        )
      }
    } catch (error) {
      showToast(
        tx(
          `Не удалось прочитать GetCapabilities: ${String(error)}`,
          `Could not read GetCapabilities: ${String(error)}`,
        ),
      )
    } finally {
      setWmtsBusy(false)
    }
  }

  const applyHeaderPreset = (header: string, value: string) => {
    const keep = headerText
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line &&
          !line.toLowerCase().startsWith(`${header.toLowerCase()}:`),
      )
    keep.push(`${header}: ${value}`)
    setHeaderText(keep.join('\n'))
  }

  const submitSource = async () => {
    if (!sourceDraft.name.trim() || !sourceDraft.url.trim()) {
      showToast(
        tx(
          'Укажите название и URL источника',
          'Provide a source name and URL',
        ),
      )
      return
    }
    const badHeader = headerText
      .split('\n')
      .map((line) => line.trim())
      .find(
        (line) =>
          line &&
          !line.startsWith('#') &&
          (line.indexOf(':') <= 0 ||
            !line.slice(line.indexOf(':') + 1).trim()),
      )
    if (badHeader) {
      showToast(
        tx(
          `Заголовок должен быть в виде «Имя: значение»: ${badHeader}`,
          `A header must use “Name: value”: ${badHeader}`,
        ),
      )
      return
    }
    const validUrl =
      sourceDraft.kind === 'wms'
        ? /\{bbox\}/.test(sourceDraft.url) ||
          /\{bbox-epsg-3857\}/.test(sourceDraft.url)
        : sourceDraft.kind === 'wmts'
          ? hasXyzTokens(sourceDraft.url) ||
            (/\{TileMatrix\}/.test(sourceDraft.url) &&
              /\{TileCol\}/.test(sourceDraft.url) &&
              /\{TileRow\}/.test(sourceDraft.url))
          : hasXyzTokens(sourceDraft.url)
    if (!validUrl) {
      showToast(
        sourceDraft.kind === 'wms'
          ? tx(
              'В URL WMS нужен плейсхолдер {bbox-epsg-3857}',
              'The WMS URL needs a {bbox-epsg-3857} placeholder',
            )
          : sourceDraft.kind === 'wmts'
            ? tx(
                'В URL WMTS нужны {TileMatrix}, {TileCol}, {TileRow} или {z}, {x}, {y}',
                'The WMTS URL needs {TileMatrix}, {TileCol}, {TileRow} or {z}, {x}, {y}',
              )
            : tx(
                'В URL нужны плейсхолдеры {z}, {x} и {y} (или {-y})',
                'The URL needs {z}, {x} and {y} placeholders (or {-y})',
              ),
      )
      return
    }
    setSourceBusy(true)
    const previous = sourceDraft.id
      ? customSources.find((source) => source.id === sourceDraft.id)
      : undefined
    const cacheAffected =
      previous !== undefined &&
      (previous.url !== sourceDraft.url.trim() ||
        previous.kind !== sourceDraft.kind ||
        previous.scheme !== sourceDraft.scheme ||
        previous.tileSize !== sourceDraft.tileSize)
    try {
      await saveCustomSource({
        ...sourceDraft,
        headers: parseHeaders(headerText),
      })
      // Cached tiles are keyed by source id; a changed URL/tiling must not
      // keep serving images from the old endpoint.
      if (cacheAffected && sourceDraft.id) {
        await clearCache(sourceDraft.id)
      }
      await refreshSources()
      setSourceForm(false)
      setHeaderText('')
      setWmtsLayers([])
      setSourceDraft((draft) => ({
        ...draft,
        id: undefined,
        name: '',
        kind: 'xyz',
        url: '',
        attribution: '',
      }))
      showToast(
        sourceDraft.id
          ? tx('Источник обновлён', 'Source updated')
          : tx(
              'Источник сохранён и добавлен слоем',
              'Source saved and added as a layer',
            ),
      )
    } catch (error) {
      showToast(
        tx(
          `Не удалось сохранить источник: ${String(error)}`,
          `Could not save the source: ${String(error)}`,
        ),
      )
    } finally {
      setSourceBusy(false)
    }
  }

  const editSource = (source: CustomSource) => {
    setSourceDraft({
      id: source.id,
      name: source.name,
      kind: source.kind,
      url: source.url,
      scheme: source.scheme,
      minZoom: source.minZoom,
      maxZoom: source.maxZoom,
      tileSize: source.tileSize,
      format: source.format,
      attribution: source.attribution,
      headers: source.headers,
      rps: source.rps,
      burst: source.burst,
      offlineAllowed: source.offlineAllowed,
    })
    setHeaderText(formatHeaders(source.headers))
    setWmtsLayers([])
    setSourceForm(true)
  }

  const closeSourceForm = () => {
    setSourceForm(false)
    setHeaderText('')
    setWmtsLayers([])
    setSourceDraft((draft) => ({
      ...draft,
      id: undefined,
      name: '',
      kind: 'xyz',
      url: '',
      attribution: '',
    }))
  }

  const runMapExport = async (format: MapExportFormat) => {
    if (!map) return
    setMapExportBusy(format)
    try {
      const options = { grid: exportGrid, legend: exportLegend }
      const result =
        format === 'png'
          ? await exportMapPng(map, options)
          : format === 'tiff'
            ? await exportMapGeoTiff(map, options)
            : await exportMapPdf(map, options)
      if (result) {
        showToast(
          tx(
            `Снимок сохранён: ${result.image}` +
              (result.worldFile ? ` · ${result.worldFile}` : ''),
            `Snapshot saved: ${result.image}` +
              (result.worldFile ? ` · ${result.worldFile}` : ''),
          ),
        )
      }
    } catch (error) {
      showToast(
        tx(
          `Экспорт не удался: ${String(error)}`,
          `Export failed: ${String(error)}`,
        ),
      )
    } finally {
      setMapExportBusy(null)
    }
  }

  const finishGeoPackagePick = (layer: string | null) => {
    gpkgPicker?.resolve(layer)
    setGpkgPicker(null)
  }

  const importVectors = async () => {
    try {
      const result = await importVectorLayerFile({
        chooseGeoPackageLayer: (layers) =>
          new Promise((resolve) => setGpkgPicker({ layers, resolve })),
      })
      if (!result) return
      const bounds = vectorBounds(result.layer.features)
      if (bounds && map) {
        map.fitBounds(bounds, { padding: 70, maxZoom: 15, duration: 700 })
      }
      showToast(
        tx(
          `${result.layer.name}: ${formatCount(result.layer.features.length)} объектов` +
            (result.srs ? ` · ${result.srs}` : '') +
            (result.skipped
              ? `, пропущено ${formatCount(result.skipped)}`
              : ''),
          `${result.layer.name}: ${formatCount(result.layer.features.length)} features` +
            (result.srs ? ` · ${result.srs}` : '') +
            (result.skipped
              ? `, ${formatCount(result.skipped)} skipped`
              : ''),
        ),
      )
    } catch (error) {
      showToast(
        tx(
          `Не удалось импортировать слой: ${String(error)}`,
          `Could not import the layer: ${String(error)}`,
        ),
      )
    }
  }

  const importXyz = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: true,
        title: tx(
          'Импорт папки XYZ (z/x/y)',
          'Import an XYZ folder (z/x/y)',
        ),
      })
      const path = Array.isArray(selected) ? selected[0] : selected
      if (typeof path !== 'string' || !path) return
      showToast(tx('Сканирую XYZ-папку…', 'Scanning the XYZ folder…'))
      const result = await importXyzFolder(path, undefined, packLicense)
      await openPackPath(result.path)
      showToast(
        tx(
          `XYZ упакован: ${formatCount(result.tiles)} тайлов · z${result.minZoom}–z${result.maxZoom}` +
            (result.skipped
              ? ` · пропущено ${formatCount(result.skipped)}`
              : ''),
          `XYZ packed: ${formatCount(result.tiles)} tiles · z${result.minZoom}–z${result.maxZoom}` +
            (result.skipped
              ? ` · ${formatCount(result.skipped)} skipped`
              : ''),
        ),
      )
    } catch (error) {
      showToast(
        tx(
          `Не удалось импортировать XYZ: ${String(error)}`,
          `Could not import XYZ: ${String(error)}`,
        ),
      )
    }
  }

  const exportVector = async (layer: VectorLayer) => {
    try {
      const path = await exportVectorLayerKmz(layer)
      if (path)
        showToast(tx(`Слой сохранён: ${path}`, `Layer saved: ${path}`))
    } catch (error) {
      showToast(
        tx(
          `Не удалось экспортировать слой: ${String(error)}`,
          `Could not export the layer: ${String(error)}`,
        ),
      )
    }
  }

  const removeVector = (layer: VectorLayer) => {
    if (
      !window.confirm(
        tx(`Удалить слой «${layer.name}»?`, `Delete layer “${layer.name}”?`),
      )
    )
      return
    if (attributeLayerId === layer.id) setAttributeLayerId(null)
    removeVectorLayer(layer.id)
  }

  const removeSource = async (id: string, name: string) => {
    if (
      !window.confirm(
        tx(`Удалить источник «${name}»?`, `Delete source “${name}”?`),
      )
    )
      return
    try {
      await deleteCustomSource(id)
      await refreshSources()
      showToast(tx(`Источник удалён: ${name}`, `Source deleted: ${name}`))
    } catch (error) {
      showToast(
        tx(
          `Не удалось удалить источник: ${String(error)}`,
          `Could not delete the source: ${String(error)}`,
        ),
      )
    }
  }

  const attributeLayer = attributeLayerId
    ? vectorLayers.find((layer) => layer.id === attributeLayerId)
    : undefined
  const attributes = attributeLayer
    ? attributeTable(attributeLayer.features)
    : null
  const query = attributeQuery.trim().toLowerCase()
  const attributeRows =
    attributes?.rows.filter(
      (row) =>
        !query ||
        Object.values(row.values).some((value) =>
          value.toLowerCase().includes(query),
        ),
    ) ?? []

  return (
    <>
      <aside className="inspector" aria-label={t(titles[panel])}>
      <div className="inspector-header">
        <div>
          <span className="eyebrow">Mappa workspace</span>
          <h2>{t(titles[panel])}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => setPanel(null)}
          aria-label={tx('Закрыть панель', 'Close panel')}
          title={tx('Закрыть', 'Close')}
        >
          <X size={16} />
        </button>
      </div>

      {panel === 'layers' && (
        <div className="inspector-body">
          <section className="card provider-card">
            <div className="card-heading">
              <span className="card-icon">
                <Layers3 size={15} />
              </span>
              <div>
                <span className="eyebrow">
                  {tx('Активная подложка', 'Active basemap')}
                </span>
                <strong>{provider.label}</strong>
              </div>
              <span
                className="status-dot"
                title={tx('Активна', 'Active')}
              />
            </div>
            <p>{provider.description}</p>
            <div className="meta-row">
              <a href={provider.terms} target="_blank" rel="noreferrer">
                {provider.attribution}
                <ExternalLink size={11} />
              </a>
              <span>{tx(`до z${provider.maxZoom}`, `up to z${provider.maxZoom}`)}</span>
            </div>
          </section>

          <section className="section">
            <div className="section-heading">
              <span>{tx('Снимок карты', 'Map snapshot')}</span>
              <span className="mono">EPSG:3857</span>
            </div>
            <div className="marker-actions">
              {(['png', 'tiff', 'pdf'] as const).map((format) => (
                <button
                  key={format}
                  type="button"
                  className="ghost-button"
                  onClick={() => void runMapExport(format)}
                  disabled={!isNative || mapExportBusy !== null}
                  title={
                    format === 'png'
                      ? tx('PNG + файл привязки .pgw', 'PNG + .pgw world file')
                      : format === 'tiff'
                        ? tx('GeoTIFF + .tfw', 'GeoTIFF + .tfw')
                        : tx(
                            'PDF с сеткой и легендой',
                            'PDF with grid and legend',
                          )
                  }
                >
                  {mapExportBusy === format ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <FileDown size={14} />
                  )}
                  {format === 'png'
                    ? 'PNG'
                    : format === 'tiff'
                      ? 'GeoTIFF'
                      : 'PDF'}
                </button>
              ))}
            </div>
            <label className="source-check">
              <input
                type="checkbox"
                checked={exportGrid}
                onChange={(event) => setExportGrid(event.target.checked)}
              />
              {tx('Координатная сетка', 'Coordinate grid')}
            </label>
            <label className="source-check">
              <input
                type="checkbox"
                checked={exportLegend}
                onChange={(event) => setExportLegend(event.target.checked)}
              />
              {tx(
                'Легенда, атрибуция и масштаб',
                'Legend, attribution and scale',
              )}
            </label>
            <p className="settings-hint">
              {tx(
                'Снимок берётся с текущего вида. PNG и GeoTIFF получают файл привязки в Web Mercator; PDF встраивает сетку и легенду в изображение.',
                'The snapshot uses the current view. PNG and GeoTIFF get a world file in Web Mercator; PDF embeds the grid and legend into the image.',
              )}
            </p>
          </section>

          <section className="section">
            <div className="section-heading">
              <span>{tx('Слои', 'Layers')}</span>
              <button
                type="button"
                className="ghost-button"
                onClick={() =>
                  showToast(
                    tx(
                      'Добавление слоёв — следующий этап',
                      'Adding layers is the next milestone',
                    ),
                  )
                }
              >
                <Plus size={14} />
                {tx('Добавить', 'Add')}
              </button>
            </div>

            <div className="layer-list">
              {PROVIDERS.map((item) => {
                const state = layers[item.id]
                return (
                  <div
                    className={`layer-row${state.visible ? ' is-visible' : ''}`}
                    key={item.id}
                  >
                    <button
                      type="button"
                      className="layer-eye"
                      onClick={() => toggleLayer(item.id)}
                      aria-label={
                        state.visible
                          ? tx(`Скрыть ${item.label}`, `Hide ${item.label}`)
                          : tx(`Показать ${item.label}`, `Show ${item.label}`)
                      }
                      aria-pressed={state.visible}
                    >
                      {state.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                    </button>
                    <div className="layer-main">
                      <div className="layer-title">
                        <strong>{item.label}</strong>
                        <span>{item.short}</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={state.opacity}
                        onChange={(event) =>
                          setLayerOpacity(
                            item.id,
                            Number(event.target.value),
                          )
                        }
                        aria-label={tx(
                          `Прозрачность ${item.label}`,
                          `Opacity of ${item.label}`,
                        )}
                      />
                    </div>
                    <span className="layer-opacity">
                      {Math.round(state.opacity * 100)}%
                    </span>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="section">
            <div className="section-heading">
              <span>{tx('Покрытие кэша', 'Cache coverage')}</span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setCoverageVisible(!coverageVisible)}
                disabled={!isNative}
                title={
                  isNative
                    ? tx(
                        'Показать скачанные тайлы активной подложки',
                        'Show cached tiles of the active basemap',
                      )
                    : tx(
                        'Доступно в нативном приложении',
                        'Available in the native app',
                      )
                }
              >
                {coverageVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                {coverageVisible ? tx('Скрыть', 'Hide') : tx('Показать', 'Show')}
              </button>
            </div>
            {coverageVisible && (
              <div className="coverage-controls">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void refreshCoverage(providerId)}
                  disabled={coverageBusy}
                >
                  {coverageBusy ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  {tx('Обновить', 'Refresh')}
                </button>
                <span className="mono">
                  {formatCount(coverageTiles.length)}
                  {coverageTruncated ? '+' : ''} {tx('тайлов', 'tiles')}
                </span>
              </div>
            )}
            {coverageVisible && (
              <p className="settings-hint">
                {tx(
                  'Полупрозрачные квадраты показывают тайлы активной подложки в текущем виде. Обновляется после остановки карты.',
                  'Translucent squares show cached tiles of the active basemap in the current view. Refreshes after the map stops moving.',
                )}
                {coverageTruncated &&
                  tx(
                    ' Показаны первые 50 000 тайлов.',
                    ' Showing the first 50,000 tiles.',
                  )}
                {coverageError &&
                  tx(
                    ` Ошибка: ${coverageError}`,
                    ` Error: ${coverageError}`,
                  )}
              </p>
            )}
          </section>

          <section className="section">
            <div className="section-heading">
              <span>
                {tx('Свои источники', 'Custom sources')} ·{' '}
                {formatCount(customSources.length)}
              </span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setSourceForm((open) => !open)}
                disabled={!isNative}
                title={
                  isNative
                    ? tx(
                        'Добавить XYZ/TMS, WMS или WMTS источник',
                        'Add an XYZ/TMS, WMS or WMTS source',
                      )
                    : tx(
                        'Доступно в нативном приложении',
                        'Available in the native app',
                      )
                }
              >
                <Plus size={14} />
                {tx('Добавить', 'Add')}
              </button>
            </div>

            {sourceForm && (
              <div className="source-form">
                <div className="section-heading">
                  <span>
                    {sourceDraft.id
                      ? tx('Редактировать источник', 'Edit source')
                      : tx('Новый источник', 'New source')}
                  </span>
                </div>
                <label>
                  {tx('Название', 'Name')}
                  <input
                    value={sourceDraft.name}
                    onChange={(event) =>
                      setSourceDraft((draft) => ({
                        ...draft,
                        name: event.target.value,
                      }))
                    }
                    placeholder={tx('Мой сервер', 'My server')}
                  />
                </label>
                <label>
                  {tx('Протокол', 'Protocol')}
                  <select
                    value={sourceDraft.kind}
                    onChange={(event) => {
                      const kind = event.target.value as
                        | 'xyz'
                        | 'wms'
                        | 'wmts'
                      setWmtsLayers([])
                      setSourceDraft((draft) => ({
                        ...draft,
                        kind,
                        scheme: kind === 'xyz' ? draft.scheme : 'xyz',
                      }))
                    }}
                  >
                    <option value="xyz">XYZ / TMS</option>
                    <option value="wms">WMS (GetMap)</option>
                    <option value="wmts">WMTS</option>
                  </select>
                </label>
                <label>
                  {sourceDraft.kind === 'wms'
                    ? tx(
                        `URL GetMap с {'{bbox-epsg-3857}'}`,
                        `GetMap URL with {'{bbox-epsg-3857}'}`,
                      )
                    : sourceDraft.kind === 'wmts'
                      ? tx(
                          `URL GetCapabilities или шаблон {'{TileMatrix}'}`,
                          `GetCapabilities URL or {'{TileMatrix}'} template`,
                        )
                      : tx(
                          `URL с {'{z}'}, {'{x}'}, {'{y}'}`,
                          `URL with {'{z}'}, {'{x}'}, {'{y}'}`,
                        )}
                  <input
                    value={sourceDraft.url}
                    onChange={(event) => {
                      setWmtsLayers([])
                      setSourceDraft((draft) => ({
                        ...draft,
                        url: event.target.value,
                      }))
                    }}
                    placeholder={
                      sourceDraft.kind === 'wms'
                        ? 'https://wms.example.org/?service=WMS&request=GetMap&layers=demo&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256'
                        : sourceDraft.kind === 'wmts'
                          ? 'https://tiles.example.org/wmts?request=GetCapabilities'
                          : 'https://tiles.example.org/{z}/{x}/{y}.png'
                    }
                    spellCheck={false}
                  />
                </label>
                {sourceDraft.kind === 'wms' && (
                  <span className="source-hint">
                    {tx(
                      'BBOX подставляется в EPSG:3857; width/height должны быть 256 или 512. Ключ можно передать заголовком ниже.',
                      'BBOX is substituted in EPSG:3857; width/height must be 256 or 512. An API key can be passed as a header below.',
                    )}
                  </span>
                )}
                {sourceDraft.kind === 'wmts' && (
                  <div className="wmts-loader">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => void loadWmtsLayers()}
                      disabled={wmtsBusy || !isNative}
                    >
                      {wmtsBusy ? (
                        <Loader2 size={14} className="spin" />
                      ) : (
                        <Globe2 size={14} />
                      )}
                      {tx('Из GetCapabilities', 'From GetCapabilities')}
                    </button>
                    {wmtsLayers.length > 0 && (
                      <label>
                        {tx('Слой', 'Layer')}
                        <select
                          value={
                            wmtsLayers.some(
                              (item) => item.url === sourceDraft.url,
                            )
                              ? sourceDraft.url
                              : ''
                          }
                          onChange={(event) => {
                            const layer = wmtsLayers.find(
                              (item) => item.url === event.target.value,
                            )
                            if (layer) applyWmtsLayer(layer)
                          }}
                        >
                          <option value="" disabled>
                            {tx('Выберите слой…', 'Choose a layer…')}
                          </option>
                          {wmtsLayers.map((layer) => (
                            <option
                              key={`${layer.identifier}/${layer.matrixSet}`}
                              value={layer.url}
                            >
                              {layer.title} · {layer.matrixSet} · z
                              {layer.minZoom}–{layer.maxZoom}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <span className="source-hint">
                      {tx(
                        'Поддерживаются растровые слои в Web Mercator с числовыми уровнями. Заголовки ниже используются при запросе возможностей.',
                        'Raster layers in Web Mercator with numeric zoom levels are supported. The headers below are used for the capabilities request.',
                      )}
                    </span>
                  </div>
                )}
                <div className="source-grid">
                  <label>
                    {tx('Мин. зум', 'Min zoom')}
                    <input
                      type="number"
                      min="0"
                      max="24"
                      value={sourceDraft.minZoom}
                      onChange={(event) =>
                        setSourceDraft((draft) => ({
                          ...draft,
                          minZoom: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <label>
                    {tx('Макс. зум', 'Max zoom')}
                    <input
                      type="number"
                      min="0"
                      max="24"
                      value={sourceDraft.maxZoom}
                      onChange={(event) =>
                        setSourceDraft((draft) => ({
                          ...draft,
                          maxZoom: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  {sourceDraft.kind === 'xyz' && (
                    <label>
                      {tx('Схема', 'Scheme')}
                      <select
                        value={sourceDraft.scheme}
                        onChange={(event) =>
                          setSourceDraft((draft) => ({
                            ...draft,
                            scheme: event.target.value as 'xyz' | 'tms',
                          }))
                        }
                      >
                        <option value="xyz">XYZ</option>
                        <option value="tms">TMS</option>
                      </select>
                    </label>
                  )}
                  <label>
                    {tx('Тайл', 'Tile')}
                    <select
                      value={sourceDraft.tileSize}
                      onChange={(event) =>
                        setSourceDraft((draft) => ({
                          ...draft,
                          tileSize: Number(event.target.value),
                        }))
                      }
                    >
                      <option value={256}>256 px</option>
                      <option value={512}>512 px</option>
                    </select>
                  </label>
                  <label>
                    {tx('Формат', 'Format')}
                    <select
                      value={sourceDraft.format}
                      onChange={(event) =>
                        setSourceDraft((draft) => ({
                          ...draft,
                          format: event.target.value,
                        }))
                      }
                    >
                      <option value="png">PNG</option>
                      <option value="jpg">JPEG</option>
                      <option value="webp">WebP</option>
                    </select>
                  </label>
                </div>
                <label>
                  {tx('Атрибуция', 'Attribution')}
                  <input
                    value={sourceDraft.attribution}
                    onChange={(event) =>
                      setSourceDraft((draft) => ({
                        ...draft,
                        attribution: event.target.value,
                      }))
                    }
                    placeholder={tx('© Мой провайдер', '© My provider')}
                  />
                </label>
                <label>
                  {tx(
                    'HTTP-заголовки, по одному на строку',
                    'HTTP headers, one per line',
                  )}
                  <textarea
                    rows={3}
                    value={headerText}
                    onChange={(event) => setHeaderText(event.target.value)}
                    placeholder="Authorization: Bearer …"
                    spellCheck={false}
                  />
                </label>
                <div className="header-presets">
                  <span>{tx('Пресеты:', 'Presets:')}</span>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      applyHeaderPreset('Authorization', 'Bearer ')
                    }
                  >
                    Bearer
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => applyHeaderPreset('X-Api-Key', '')}
                  >
                    X-Api-Key
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      applyHeaderPreset('Authorization', 'Basic ')
                    }
                  >
                    Basic
                  </button>
                </div>
                {sourceDraft.id && (
                  <span className="source-hint">
                    {tx(
                      'Сохранённые заголовки не показываются. Оставьте поле пустым, чтобы не менять их.',
                      'Saved headers are never displayed. Leave the field empty to keep them unchanged.',
                    )}
                  </span>
                )}
                <div className="source-grid">
                  <label>
                    {tx('Запросов/с', 'Requests/s')}
                    <input
                      type="number"
                      min="1"
                      max="20"
                      value={sourceDraft.rps}
                      onChange={(event) =>
                        setSourceDraft((draft) => ({
                          ...draft,
                          rps: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <label>
                    Burst
                    <input
                      type="number"
                      min="1"
                      max="64"
                      value={sourceDraft.burst}
                      onChange={(event) =>
                        setSourceDraft((draft) => ({
                          ...draft,
                          burst: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                </div>
                <label className="source-check">
                  <input
                    type="checkbox"
                    checked={sourceDraft.offlineAllowed}
                    onChange={(event) =>
                      setSourceDraft((draft) => ({
                        ...draft,
                        offlineAllowed: event.target.checked,
                      }))
                    }
                  />
                  {tx(
                    'Разрешить офлайн-скачивание',
                    'Allow offline downloads',
                  )}
                </label>
                <div className="marker-actions">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void submitSource()}
                    disabled={sourceBusy}
                  >
                    {sourceBusy ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <Save size={14} />
                    )}
                    {tx('Сохранить', 'Save')}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={closeSourceForm}
                  >
                    {tx('Отмена', 'Cancel')}
                  </button>
                </div>
              </div>
            )}

            {customSources.length === 0 && !sourceForm ? (
              <p className="pack-empty">
                {tx(
                  'Подключите свой XYZ/TMS сервер или API с ключом в заголовке. Заголовки хранятся локально с правами владельца.',
                  'Connect your own XYZ/TMS server or an API with a key in a header. Headers are stored locally with owner-only permissions.',
                )}
              </p>
            ) : (
              <div className="layer-list">
                {customSources.map((source) => {
                  const layer = customLayers[source.id] ?? {
                    visible: true,
                    opacity: 1,
                  }
                  return (
                    <div
                      className={`layer-row pack-row${layer.visible ? ' is-visible' : ''}`}
                      key={source.id}
                    >
                      <button
                        type="button"
                        className="layer-eye"
                        onClick={() => toggleCustomLayer(source.id)}
                        aria-label={
                          layer.visible
                            ? tx(`Скрыть ${source.name}`, `Hide ${source.name}`)
                            : tx(
                                `Показать ${source.name}`,
                                `Show ${source.name}`,
                              )
                        }
                        aria-pressed={layer.visible}
                      >
                        {layer.visible ? (
                          <Eye size={15} />
                        ) : (
                          <EyeOff size={15} />
                        )}
                      </button>
                      <div className="layer-main">
                        <div className="layer-title">
                          <strong>{source.name}</strong>
                          <span>
                            {source.kind === 'wms'
                              ? 'WMS'
                              : source.scheme.toUpperCase()}{' '}
                            · {source.format}
                          </span>
                        </div>
                        <div className="pack-meta">
                          z{source.minZoom}–z{source.maxZoom} · {source.url}
                          {source.attribution ? ` · ${source.attribution}` : ''}
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={layer.opacity}
                          onChange={(event) =>
                            setCustomLayerOpacity(
                              source.id,
                              Number(event.target.value),
                            )
                          }
                          aria-label={tx(
                            `Прозрачность ${source.name}`,
                            `Opacity of ${source.name}`,
                          )}
                        />
                      </div>
                      <span className="layer-opacity">
                        {Math.round(layer.opacity * 100)}%
                      </span>
                      <button
                        type="button"
                        className="icon-button pack-close"
                        onClick={() => editSource(source)}
                        aria-label={tx(
                          `Изменить ${source.name}`,
                          `Edit ${source.name}`,
                        )}
                        title={tx('Изменить источник', 'Edit source')}
                      >
                        <PenLine size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-button pack-close"
                        onClick={() => void removeSource(source.id, source.name)}
                        aria-label={tx(
                          `Удалить ${source.name}`,
                          `Delete ${source.name}`,
                        )}
                        title={tx('Удалить источник', 'Delete source')}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section className="section">
            <div className="section-heading">
              <span>
                {tx('Векторные слои', 'Vector layers')} ·{' '}
                {formatCount(vectorLayers.length)}
              </span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void importVectors()}
                disabled={!isNative}
                title={
                  isNative
                    ? tx(
                        'Импортировать GeoJSON, GPX, KML или KMZ',
                        'Import GeoJSON, GPX, KML or KMZ',
                      )
                    : tx(
                        'Доступно в нативном приложении',
                        'Available in the native app',
                      )
                }
              >
                <Upload size={14} />
                {tx('Импорт', 'Import')}
              </button>
            </div>

            {vectorLayers.length === 0 ? (
              <p className="pack-empty">
                {tx(
                  'GeoJSON, GPX, KML и KMZ открываются как слои со своими стилями, прозрачностью и таблицей атрибутов.',
                  'GeoJSON, GPX, KML and KMZ open as layers with their own styles, opacity and attribute table.',
                )}
              </p>
            ) : (
              <div className="layer-list">
                {vectorLayers.map((layer) => (
                  <div
                    className={`layer-row pack-row vector-row${layer.visible ? ' is-visible' : ''}`}
                    key={layer.id}
                  >
                    <button
                      type="button"
                      className="layer-eye"
                      onClick={() => toggleVectorLayer(layer.id)}
                      aria-label={
                        layer.visible
                          ? tx(`Скрыть ${layer.name}`, `Hide ${layer.name}`)
                          : tx(`Показать ${layer.name}`, `Show ${layer.name}`)
                      }
                      aria-pressed={layer.visible}
                    >
                      {layer.visible ? (
                        <Eye size={15} />
                      ) : (
                        <EyeOff size={15} />
                      )}
                    </button>
                    <div className="layer-main">
                      <div className="layer-title">
                        <strong>{layer.name}</strong>
                        <span>
                          {layer.format.toUpperCase()} ·{' '}
                          {formatCount(layer.features.length)}
                        </span>
                      </div>
                      <div className="vector-style">
                        <label title={tx('Цвет слоя', 'Layer colour')}>
                          <input
                            type="color"
                            value={layer.style.color}
                            onChange={(event) =>
                              setVectorLayerStyle(layer.id, {
                                color: event.target.value,
                              })
                            }
                            aria-label={tx(
                              `Цвет ${layer.name}`,
                              `Colour of ${layer.name}`,
                            )}
                          />
                        </label>
                        <label title={tx('Толщина линии, px', 'Line width, px')}>
                          <input
                            type="number"
                            min="0.5"
                            max="12"
                            step="0.5"
                            value={layer.style.lineWidth}
                            onChange={(event) =>
                              setVectorLayerStyle(layer.id, {
                                lineWidth: Math.max(
                                  0.5,
                                  Math.min(12, Number(event.target.value)),
                                ),
                              })
                            }
                            aria-label={tx(
                              `Толщина линии ${layer.name}`,
                              `Line width of ${layer.name}`,
                            )}
                          />
                        </label>
                        <label title={tx('Заливка полигонов', 'Polygon fill')}>
                          <input
                            type="number"
                            min="0"
                            max="1"
                            step="0.05"
                            value={layer.style.fillOpacity}
                            onChange={(event) =>
                              setVectorLayerStyle(layer.id, {
                                fillOpacity: Math.max(
                                  0,
                                  Math.min(1, Number(event.target.value)),
                                ),
                              })
                            }
                            aria-label={tx(
                              `Заливка ${layer.name}`,
                              `Fill of ${layer.name}`,
                            )}
                          />
                        </label>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={layer.opacity}
                        onChange={(event) =>
                          setVectorLayerOpacity(
                            layer.id,
                            Number(event.target.value),
                          )
                        }
                        aria-label={tx(
                          `Прозрачность ${layer.name}`,
                          `Opacity of ${layer.name}`,
                        )}
                      />
                    </div>
                    <span className="layer-opacity">
                      {Math.round(layer.opacity * 100)}%
                    </span>
                    <button
                      type="button"
                      className="icon-button pack-close"
                      onClick={() => void exportVector(layer)}
                      aria-label={tx(
                        `Экспортировать ${layer.name} в KMZ`,
                        `Export ${layer.name} to KMZ`,
                      )}
                      title={tx('Экспорт в KMZ', 'Export to KMZ')}
                    >
                      <FileDown size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button pack-close"
                      onClick={() => {
                        setFeatureMode('edit')
                        selectVectorFeature(null)
                        setPanel('features')
                        showToast(
                          tx(
                            `Режим правки: выберите объект слоя «${layer.name}»`,
                            `Edit mode: choose a feature in layer “${layer.name}”`,
                          ),
                        )
                      }}
                      aria-label={tx(
                        `Редактировать ${layer.name}`,
                        `Edit ${layer.name}`,
                      )}
                      title={tx('Редактировать геометрию', 'Edit geometry')}
                    >
                      <PenLine size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button pack-close"
                      onClick={() => {
                        setAttributeQuery('')
                        setAttributeLayerId(layer.id)
                      }}
                      aria-label={tx(
                        `Атрибуты ${layer.name}`,
                        `Attributes of ${layer.name}`,
                      )}
                      title={tx('Таблица атрибутов', 'Attribute table')}
                    >
                      <Table2 size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button pack-close"
                      onClick={() => {
                        const bounds = vectorBounds(layer.features)
                        if (bounds && map) {
                          map.fitBounds(bounds, {
                            padding: 70,
                            maxZoom: 15,
                            duration: 700,
                          })
                        }
                      }}
                      aria-label={tx(
                        `Показать ${layer.name}`,
                        `Show ${layer.name}`,
                      )}
                      title={tx('Показать на карте', 'Show on the map')}
                    >
                      <Globe2 size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button pack-close"
                      onClick={() => removeVector(layer)}
                      aria-label={tx(
                        `Удалить ${layer.name}`,
                        `Delete ${layer.name}`,
                      )}
                      title={tx('Удалить слой', 'Delete layer')}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <label className="source-check vector-snap">
              <input
                type="checkbox"
                checked={snapping}
                onChange={toggleSnapping}
              />
              {tx(
                'Привязка к вершинам и рёбрам при рисовании и измерении',
                'Snap to vertices and edges while drawing and measuring',
              )}
            </label>
            <label className="source-check vector-snap">
              <input
                type="checkbox"
                checked={mapGrid}
                onChange={toggleMapGrid}
              />
              {tx('Координатная сетка на карте', 'Coordinate grid on the map')}
            </label>
          </section>

          <section className="section">
            <div className="section-heading">
              <span>{tx('Офлайн-паки', 'Offline packs')}</span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  void importPack()
                    .then((pack) => {
                      if (pack)
                        showToast(
                          tx(
                            `Пак открыт: ${pack.name}`,
                            `Pack opened: ${pack.name}`,
                          ),
                        )
                    })
                    .catch((error: unknown) =>
                      showToast(
                        tx(
                          `Не удалось открыть пак: ${String(error)}`,
                          `Could not open the pack: ${String(error)}`,
                        ),
                      ),
                    )
                }}
                disabled={!isNative}
                title={
                  isNative
                    ? tx(
                        'Открыть MBTiles или PMTiles',
                        'Open MBTiles or PMTiles',
                      )
                    : tx(
                        'Доступно в нативном приложении',
                        'Available in the native app',
                      )
                }
              >
                <PackageOpen size={14} />
                {tx('Импорт', 'Import')}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void importXyz()}
                disabled={!isNative}
                title={tx(
                  'Упаковать папку z/x/y в MBTiles',
                  'Pack a z/x/y folder into MBTiles',
                )}
              >
                <FolderOpen size={14} />
                XYZ
              </button>
            </div>

            {packs.length === 0 ? (
              <p className="pack-empty">
                {tx(
                  'Подключите готовый .mbtiles или .pmtiles и покажите его поверх карты. Пак читается напрямую, без распаковки.',
                  'Open an existing .mbtiles or .pmtiles and show it over the map. The pack is read directly, without unpacking.',
                )}
              </p>
            ) : (
              <div className="layer-list">
                {packs.map((pack) => (
                  <div
                    className={`layer-row pack-row${pack.visible ? ' is-visible' : ''}`}
                    key={pack.id}
                  >
                    <button
                      type="button"
                      className="layer-eye"
                      onClick={() => togglePack(pack.id)}
                      aria-label={
                        pack.visible
                          ? tx(`Скрыть ${pack.name}`, `Hide ${pack.name}`)
                          : tx(`Показать ${pack.name}`, `Show ${pack.name}`)
                      }
                      aria-pressed={pack.visible}
                    >
                      {pack.visible ? (
                        <Eye size={15} />
                      ) : (
                        <EyeOff size={15} />
                      )}
                    </button>
                    <div
                      className="layer-main"
                      role="button"
                      tabIndex={0}
                      title={tx('Показать пак на карте', 'Show the pack on the map')}
                      onClick={() =>
                        map?.fitBounds(
                          [
                            [pack.west, pack.south],
                            [pack.east, pack.north],
                          ],
                          { padding: 70, duration: 700 },
                        )
                      }
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        map?.fitBounds(
                          [
                            [pack.west, pack.south],
                            [pack.east, pack.north],
                          ],
                          { padding: 70, duration: 700 },
                        )
                      }}
                    >
                      <div className="layer-title">
                        <strong>{pack.name}</strong>
                        <span>
                          {pack.kind.toUpperCase()} · {pack.format}
                        </span>
                      </div>
                      <div className="pack-meta">
                        z{pack.minZoom}–z{pack.maxZoom}
                        {pack.tiles
                          ? tx(
                              ` · ${formatCount(pack.tiles)} тайлов`,
                              ` · ${formatCount(pack.tiles)} tiles`,
                            )
                          : ''}
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={pack.opacity}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          setPackOpacity(pack.id, Number(event.target.value))
                        }
                        aria-label={tx(
                          `Прозрачность ${pack.name}`,
                          `Opacity of ${pack.name}`,
                        )}
                      />
                    </div>
                    <span className="layer-opacity">
                      {Math.round(pack.opacity * 100)}%
                    </span>
                    <button
                      type="button"
                      className="icon-button pack-close"
                      onClick={() => {
                        void closePack(pack.id)
                          .then(() =>
                            showToast(
                              tx(
                                `Пак закрыт: ${pack.name}`,
                                `Pack closed: ${pack.name}`,
                              ),
                            ),
                          )
                          .catch((error: unknown) =>
                            showToast(
                              tx(
                                `Не удалось закрыть: ${String(error)}`,
                                `Could not close: ${String(error)}`,
                              ),
                            ),
                          )
                      }}
                      aria-label={tx(
                        `Закрыть ${pack.name}`,
                        `Close ${pack.name}`,
                      )}
                      title={tx('Закрыть пак', 'Close pack')}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card cache-card">
            <div className="card-heading">
              <span className="card-icon">
                <Database size={15} />
              </span>
              <div>
                <span className="eyebrow">{tx('Кэш тайлов', 'Tile cache')}</span>
                <strong>
                  {isNative
                    ? cache
                      ? tx(
                          `${formatCount(cache.tiles)} тайлов`,
                          `${formatCount(cache.tiles)} tiles`,
                        )
                      : 'SQLite WAL'
                    : tx('Только браузер', 'Browser only')}
                </strong>
              </div>
              <span className="phase-pill">
                {isNative ? 'offline-first' : tx('нет диска', 'no disk')}
              </span>
            </div>
            <p>
              {isNative
                ? cache
                  ? tx(
                      `${formatBytes(cache.bytes)} на диске · попадания ${formatCount(cache.hits)} · промахи ${formatCount(cache.misses)}.`,
                      `${formatBytes(cache.bytes)} on disk · hits ${formatCount(cache.hits)} · misses ${formatCount(cache.misses)}.`,
                    )
                  : tx(
                      'Дисковый кэш включён, статистика загружается.',
                      'Disk cache is enabled, statistics are loading.',
                    )
                : tx(
                    'В нативном приложении тайлы кэшируются на диск и работают офлайн.',
                    'In the native app tiles are cached on disk and work offline.',
                  )}
            </p>
          </section>
        </div>
      )}

      {panel === 'downloads' && (
        <div className="inspector-body">
          {jobs.length === 0 ? (
            <section className="empty-state">
              <span className="empty-icon">
                <Download size={24} />
              </span>
              <h3>{tx('Очередь пуста', 'The queue is empty')}</h3>
              <p>
                {isNative
                  ? tx(
                      'Выберите район на карте, диапазон зумов и поставьте загрузку в очередь. Прогресс сохраняется между запусками.',
                      'Select an area on the map, choose a zoom range and queue the download. Progress survives restarts.',
                    )
                  : tx(
                      'Очередь доступна в нативном приложении. В браузере можно оценить район и скопировать bbox.',
                      'The queue is available in the native app. In the browser you can estimate an area and copy its bbox.',
                    )}
              </p>
              <button
                type="button"
                className="primary-button"
                onClick={() => setDownloadOpen(true)}
              >
                <Download size={15} />
                {tx('Оценить район', 'Estimate area')}
              </button>
            </section>
          ) : (
            <>
              <div className="downloads-toolbar">
                <span>
                  {tx(
                    `${formatCount(jobs.length)} задач · ${formatCount(jobs.filter((job) => job.status === 'running').length)} активных`,
                    `${formatCount(jobs.length)} jobs · ${formatCount(jobs.filter((job) => job.status === 'running').length)} active`,
                  )}
                </span>
                {finished > 0 && (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      void clearFinished().catch((error: unknown) =>
                        showToast(tx(`Не удалось: ${String(error)}`, `Failed: ${String(error)}`)),
                      )
                    }}
                  >
                    <Trash2 size={13} />
                    {tx('Очистить', 'Clear')} ({finished})
                  </button>
                )}
              </div>
              <div className="job-list">
                {jobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    onAction={(action) => void runAction(job, action)}
                    onExport={async (kind) => {
                      try {
                        const report = await exportJob(
                          job.id,
                          kind,
                          packLicense,
                        )
                        showToast(
                          tx(
                            `${kind === 'pmtiles' ? 'PMTiles' : 'MBTiles'}: ${report.path} · ${formatCount(report.tiles)} тайлов` +
                              (report.missing > 0
                                ? ` · ${formatCount(report.missing)} не хватает`
                                : ''),
                            `${kind === 'pmtiles' ? 'PMTiles' : 'MBTiles'}: ${report.path} · ${formatCount(report.tiles)} tiles` +
                              (report.missing > 0
                                ? ` · ${formatCount(report.missing)} missing`
                                : ''),
                          ),
                        )
                      } catch (error) {
                        showToast(
                          tx(
                            `Экспорт не удался: ${String(error)}`,
                            `Export failed: ${String(error)}`,
                          ),
                        )
                      }
                    }}
                  />
                ))}
              </div>
              <button
                type="button"
                className="secondary-button full-width"
                onClick={() => setDownloadOpen(true)}
              >
                <Plus size={15} />
                {tx('Новая загрузка', 'New download')}
              </button>
            </>
          )}
        </div>
      )}

      {panel === 'settings' && <SettingsPanel />}

      {panel === 'markers' && <MarkersPanel map={map} />}

      {panel === 'features' && <FeaturesPanel map={map} />}

      {panel === 'projects' && <ProjectsPanel map={map} />}
      </aside>

      {attributeLayer && attributes && (
        <div
          className="attribute-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAttributeLayerId(null)
          }}
        >
          <div
            ref={attributeDialogRef}
            className="attribute-panel"
            role="dialog"
            aria-modal="true"
            aria-label={tx(
              `Атрибуты ${attributeLayer.name}`,
              `Attributes of ${attributeLayer.name}`,
            )}
            tabIndex={-1}
          >
            <div className="attribute-header">
              <div>
                <span className="eyebrow">
                  {tx('Таблица атрибутов', 'Attribute table')}
                </span>
                <strong>{attributeLayer.name}</strong>
              </div>
              <span className="source-hint">
                {tx(
                  `${formatCount(attributes.total)} объектов`,
                  `${formatCount(attributes.total)} features`,
                )}
              </span>
              <button
                type="button"
                className="icon-button"
                onClick={() => setAttributeLayerId(null)}
                aria-label={tx('Закрыть таблицу', 'Close the table')}
              >
                <X size={16} />
              </button>
            </div>
            <input
              className="attribute-search"
              value={attributeQuery}
              onChange={(event) => setAttributeQuery(event.target.value)}
              placeholder={tx('Поиск по значениям…', 'Search values…')}
              aria-label={tx('Поиск по значениям', 'Search values')}
              autoFocus
            />
            <div className="attribute-scroll">
              {attributes.columns.length === 0 ? (
                <p className="pack-empty">
                  {tx(
                    'У объектов нет свойств. Координаты и геометрия показаны на карте.',
                    'The features have no properties. Coordinates and geometry are shown on the map.',
                  )}
                </p>
              ) : (
                <table className="attribute-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      {attributes.columns.map((column) => (
                        <th key={column}>{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {attributeRows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.id}</td>
                        {attributes.columns.map((column) => (
                          <td key={column} title={row.values[column]}>
                            {row.values[column]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="attribute-footer">
              <span>
                {tx(
                  `Показано ${formatCount(attributeRows.length)}`,
                  `Showing ${formatCount(attributeRows.length)}`,
                )}
                {attributes.truncated &&
                  tx(
                    ' · таблица обрезана до 500 строк',
                    ' · table truncated to 500 rows',
                  )}
              </span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setAttributeLayerId(null)}
              >
                {tx('Закрыть', 'Close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {gpkgPicker && (
        <div
          className="attribute-overlay"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) finishGeoPackagePick(null)
          }}
        >
          <div
            ref={gpkgDialogRef}
            className="attribute-panel gpkg-panel"
            role="dialog"
            aria-modal="true"
            aria-label={tx('Выбор слоя GeoPackage', 'Choose a GeoPackage layer')}
            tabIndex={-1}
          >
            <div className="attribute-header">
              <div>
                <span className="eyebrow">GeoPackage</span>
                <strong>{tx('Выберите слой', 'Choose a layer')}</strong>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => finishGeoPackagePick(null)}
                aria-label={tx('Отменить импорт', 'Cancel the import')}
              >
                <X size={16} />
              </button>
            </div>
            <div className="gpkg-layer-list">
              {gpkgPicker.layers.map((layer) => (
                <button
                  type="button"
                  className="gpkg-layer"
                  key={layer.name}
                  onClick={() => finishGeoPackagePick(layer.name)}
                  autoFocus={layer === gpkgPicker.layers[0]}
                >
                  <strong>{layer.name}</strong>
                  <span>
                    {layer.geometryType} · {formatCount(layer.features)} ·{' '}
                    {layer.srs}
                  </span>
                </button>
              ))}
            </div>
            <div className="attribute-footer">
              <span>
                {tx(
                  `${formatCount(gpkgPicker.layers.length)} слоёв`,
                  `${formatCount(gpkgPicker.layers.length)} layers`,
                )}
              </span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => finishGeoPackagePick(null)}
              >
                {tx('Отмена', 'Cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
