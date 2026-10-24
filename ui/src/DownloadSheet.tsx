import { useEffect, useMemo, useState } from 'react'
import { Copy, Download, Loader2, X } from 'lucide-react'
import { MAX_JOB_TILES, useDownloadsStore } from './downloads'
import { useT, useText } from './i18n'
import { isNative } from './native'
import { polygonArea } from './geo'
import { PROVIDERS, providerById } from './providers'
import { useAppStore } from './store'
import { useViewStore } from './viewStore'
import {
  estimateDownload,
  formatBounds,
  formatBytes,
  formatCount,
  formatDuration,
} from './format'

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

export function DownloadSheet() {
  const t = useT()
  const tx = useText()
  const open = useAppStore((state) => state.downloadOpen)
  const setOpen = useAppStore((state) => state.setDownloadOpen)
  const setDrawing = useAppStore((state) => state.setDrawing)
  const mapView = useViewStore((state) => state.mapView)
  const selection = useAppStore((state) => state.selection)
  const selectionPolygon = useAppStore((state) => state.selectionPolygon)
  const setSelection = useAppStore((state) => state.setSelection)
  const providerId = useAppStore((state) => state.providerId)
  const setPanel = useAppStore((state) => state.setPanel)
  const showToast = useAppStore((state) => state.showToast)
  const createDownload = useDownloadsStore((state) => state.create)

  const [minZoom, setMinZoom] = useState(10)
  const [maxZoom, setMaxZoom] = useState(13)
  const [queueing, setQueueing] = useState(false)
  const [fallbackIds, setFallbackIds] = useState<string[]>([])
  const customSources = useAppStore((state) => state.customSources)

  const provider = providerById(providerId)
  const fallbackOptions = [
    ...PROVIDERS.filter(
      (item) =>
        item.id !== providerId &&
        item.offlineAllowed &&
        item.maxZoom >= maxZoom,
    ).map((item) => ({
      id: item.id as string,
      label: item.label,
      detail: `z1–z${item.maxZoom}`,
    })),
    ...customSources
      .filter((item) => item.offlineAllowed)
      .map((item) => ({
        id: item.id,
        label: item.name,
        detail: tx('свой источник', 'custom source'),
      })),
  ]
  const polygonBounds = useMemo<
    [[number, number], [number, number]] | null
  >(() => {
    if (!selectionPolygon || selectionPolygon.length < 3) return null
    return selectionPolygon.reduce<[[number, number], [number, number]]>(
      (box, point) => [
        [Math.min(box[0][0], point[0]), Math.min(box[0][1], point[1])],
        [Math.max(box[1][0], point[0]), Math.max(box[1][1], point[1])],
      ],
      [
        [Infinity, Infinity],
        [-Infinity, -Infinity],
      ],
    )
  }, [selectionPolygon])
  const activeBounds = polygonBounds ?? selection ?? mapView.bounds
  const polygon = selectionPolygon && selectionPolygon.length >= 3
    ? selectionPolygon
    : null

  useEffect(() => {
    if (!open) return
    const base = clamp(Math.round(mapView.zoom), 1, provider.maxZoom)
    setMinZoom(base)
    setMaxZoom(clamp(base + 3, base, provider.maxZoom))
    // Reset only when the sheet opens, not while the user edits the ranges.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    setMinZoom((value) => clamp(value, 1, provider.maxZoom))
    setMaxZoom((value) => clamp(value, 1, provider.maxZoom))
  }, [provider.maxZoom])

  const estimate = useMemo(() => {
    const box = estimateDownload(activeBounds, minZoom, maxZoom)
    if (!polygon || !polygonBounds) return box
    const [[west, south], [east, north]] = polygonBounds
    const rectangle = polygonArea([
      [west, south],
      [east, south],
      [east, north],
      [west, north],
    ])
    const ratio =
      rectangle > 0 ? Math.min(1, polygonArea(polygon) / rectangle) : 1
    const tiles = Math.round(box.tiles * ratio)
    const bytes = Math.round(box.bytes * ratio)
    return {
      tiles,
      bytes,
      seconds: box.seconds > 0 ? bytes / (box.bytes / box.seconds) : 0,
    }
  }, [activeBounds, minZoom, maxZoom, polygon, polygonBounds])
  const tooLarge = estimate.tiles > MAX_JOB_TILES
  const offlineBlocked = !provider.offlineAllowed

  if (!open) return null

  const copyBbox = async () => {
    if (!activeBounds) return
    const [[west, south], [east, north]] = activeBounds
    const text = `${west.toFixed(6)},${south.toFixed(6)},${east.toFixed(6)},${north.toFixed(6)}`
    try {
      await navigator.clipboard.writeText(text)
      showToast(tx('Bbox скопирован в буфер обмена', 'Bbox copied to clipboard'))
    } catch {
      showToast(
        tx(
          `Не удалось скопировать. Bbox: ${text}`,
          `Could not copy. Bbox: ${text}`,
        ),
      )
    }
  }

  const enqueue = async () => {
    if (!activeBounds || queueing) return
    const [[west, south], [east, north]] = activeBounds
    setQueueing(true)
    try {
      const job = await createDownload({
        providerId,
        west,
        south,
        east,
        north,
        minZoom,
        maxZoom,
        polygon: polygon ?? undefined,
        sourceIds: fallbackIds,
      })
      setOpen(false)
      setPanel('downloads')
      showToast(
        tx(
          `В очереди: ${formatCount(job.totalTiles)} тайлов`,
          `Queued: ${formatCount(job.totalTiles)} tiles`,
        ),
      )
    } catch (error) {
      showToast(
        tx(
          `Не удалось поставить в очередь: ${String(error)}`,
          `Could not queue the download: ${String(error)}`,
        ),
      )
    } finally {
      setQueueing(false)
    }
  }

  return (
    <aside className="download-sheet" aria-label={t('download.title')}>
      <div className="sheet-header">
        <div>
          <span className="eyebrow">{t('download.export')}</span>
          <h2>{t('download.title')}</h2>
        </div>
        <div className="sheet-header-actions">
          <span className="phase-pill">Phase 2</span>
          <button
            type="button"
            className="icon-button"
            onClick={() => setOpen(false)}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="sheet-body">
        <div className="sheet-provider">
          <span className="provider-chip">{provider.short}</span>
          <div>
            <strong>{provider.label}</strong>
            <span>{provider.attribution}</span>
          </div>
        </div>

        {fallbackOptions.length > 0 && (
          <div className="sheet-field">
            <div className="sheet-field-heading">
              <span>{t('download.fallback')}</span>
              <span className="mono">
                {fallbackIds.length > 0
                  ? tx(
                      `${fallbackIds.length} вкл.`,
                      `${fallbackIds.length} on`,
                    )
                  : t('download.primaryOnly')}
              </span>
            </div>
            <p className="source-hint">
              {t('download.fallbackHint')}
            </p>
            <div className="fallback-list">
              {fallbackOptions.map((option) => (
                <label className="source-check" key={option.id}>
                  <input
                    type="checkbox"
                    checked={fallbackIds.includes(option.id)}
                    onChange={(event) =>
                      setFallbackIds((current) =>
                        event.target.checked
                          ? [...current.filter((id) => id !== option.id), option.id].slice(-4)
                          : current.filter((id) => id !== option.id),
                      )
                    }
                  />
                  <span>
                    {option.label} <span className="mono">{option.detail}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="estimate-hero">
          <div>
            <span className="estimate-value">
              {formatCount(estimate.tiles)}
            </span>
            <span className="estimate-label">{t('download.tiles')}</span>
          </div>
          <div>
            <span className="estimate-value">{formatBytes(estimate.bytes)}</span>
            <span className="estimate-label">{t('download.approx')}</span>
          </div>
          <div>
            <span className="estimate-value">
              {formatDuration(estimate.seconds)}
            </span>
            <span className="estimate-label">{t('download.atSpeed')}</span>
          </div>
        </div>

        <div className="sheet-field">
          <div className="sheet-field-heading">
            <span>
              {polygon
                ? `${t('download.polygon')} · ${polygon.length}`
                : selection
                  ? t('download.selection')
                  : t('download.bounds')}
            </span>
            <div className="sheet-field-actions">
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setSelection(null)
                  setDrawing(true)
                  showToast(
                    tx(
                      'Протяните прямоугольник по карте. Esc — отмена',
                      'Drag a rectangle on the map. Esc cancels',
                    ),
                  )
                }}
              >
                {t('download.select')}
              </button>
              {(selection || polygon) && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setSelection(null)}
                >
                  {t('download.reset')}
                </button>
              )}
            </div>
          </div>
          <div className="bbox-readout">{formatBounds(activeBounds)}</div>
          {polygon && (
            <span className="source-hint">
              {t('download.polygonOnly')}
            </span>
          )}
        </div>

        <div className="sheet-field">
          <div className="sheet-field-heading">
            <span>{t('download.zoomRange')}</span>
            <span className="mono">
              z{minZoom}–z{maxZoom}
            </span>
          </div>
          <label className="zoom-range">
            <span>{t('download.from')}</span>
            <input
              type="range"
              min="1"
              max={provider.maxZoom}
              value={minZoom}
              onChange={(event) => {
                const value = Number(event.target.value)
                setMinZoom(value)
                if (value > maxZoom) setMaxZoom(value)
              }}
              aria-label={tx('Минимальный зум', 'Minimum zoom')}
            />
          </label>
          <label className="zoom-range">
            <span>{t('download.to')}</span>
            <input
              type="range"
              min="1"
              max={provider.maxZoom}
              value={maxZoom}
              onChange={(event) => {
                const value = Number(event.target.value)
                setMaxZoom(value)
                if (value < minZoom) setMinZoom(value)
              }}
              aria-label={tx('Максимальный зум', 'Maximum zoom')}
            />
          </label>
        </div>

        <p
          className={`sheet-note${tooLarge || offlineBlocked ? ' is-warning' : ''}`}
        >
          {offlineBlocked
            ? tx(
                `${provider.label} не разрешает офлайн-скачивание тайлов. Для офлайн-паков выберите USGS Imagery или добавьте собственный источник.`,
                `${provider.label} does not allow offline tile downloads. For offline packs choose USGS Imagery or add a custom source.`,
              )
            : tooLarge
              ? tx(
                  `Слишком большой район для одной задачи: ${formatCount(estimate.tiles)} тайлов при лимите ${formatCount(MAX_JOB_TILES)}. Уменьшите зумы.`,
                  `Area is too large for one job: ${formatCount(estimate.tiles)} tiles against a ${formatCount(MAX_JOB_TILES)} tile limit. Reduce the zoom range.`,
                )
              : tx(
                  'Тайлы пишутся в дисковый кэш и переживают перезапуск. Уже скачанные пропускаются, очередь можно ставить на паузу.',
                  'Tiles go to the disk cache and survive restarts. Existing tiles are skipped and the queue can be paused.',
                )}
        </p>

        <div className="sheet-actions">
          <button
            type="button"
            className="primary-button"
            onClick={copyBbox}
            disabled={!activeBounds}
          >
            <Copy size={15} />
            {t('download.copyBbox')}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={enqueue}
            disabled={
              !isNative ||
              !activeBounds ||
              tooLarge ||
              offlineBlocked ||
              queueing
            }
            title={
              !isNative
                ? tx(
                    'Доступно в нативном приложении',
                    'Available in the native app',
                  )
                : offlineBlocked
                  ? tx(
                      'Провайдер не разрешает офлайн-скачивание',
                      'This provider does not allow offline downloads',
                    )
                  : tooLarge
                    ? tx('Уменьшите диапазон зумов', 'Reduce the zoom range')
                    : tx('Поставить район в очередь', 'Queue this area')
            }
          >
            {queueing ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Download size={15} />
            )}
            {queueing ? t('download.queueing') : t('download.queue')}
          </button>
        </div>
      </div>
    </aside>
  )
}
