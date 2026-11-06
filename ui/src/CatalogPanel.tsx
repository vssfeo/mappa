import { useEffect, useRef, useState } from 'react'
import { Download, Loader2, RefreshCw, Search, X } from 'lucide-react'
import { useText } from './i18n'
import { useAppStore } from './store'
import { useViewStore } from './viewStore'
import {
  DEFAULT_CATALOG_URL,
  fetchCatalog,
  filterPacks,
  type CatalogPack,
} from './catalog'
import { openMagnet } from './torrent'
import { useDialogFocus } from './useDialogFocus'

const STORAGE_KEY = 'mappa-catalog-url'

interface CatalogPanelProps {
  onClose: () => void
}

const size = (bytes: number) =>
  bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
    : `${Math.max(1, Math.round(bytes / 1024 / 1024))} MiB`

/** Searches the static pack catalog by the current map view. */
export function CatalogPanel({ onClose }: CatalogPanelProps) {
  const tx = useText()
  const providerId = useAppStore((state) => state.providerId)
  const showToast = useAppStore((state) => state.showToast)
  const bounds = useViewStore((state) => state.mapView.bounds)
  const zoom = useViewStore((state) => state.mapView.zoom)
  const dialogRef = useRef<HTMLElement | null>(null)
  useDialogFocus(dialogRef, onClose)
  const [url, setUrl] = useState(
    () => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_CATALOG_URL,
  )
  const [packs, setPacks] = useState<CatalogPack[]>([])
  const [query, setQuery] = useState('')
  const [onlyVisible, setOnlyVisible] = useState(true)
  const [sameProvider, setSameProvider] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (target = url) => {
    setBusy(true)
    setError(null)
    try {
      const catalog = await fetchCatalog(target)
      setPacks(catalog.packs)
      localStorage.setItem(STORAGE_KEY, target)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
    // Load once on open; the URL can be reloaded manually.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const visible = filterPacks(packs, {
    bounds,
    zoom,
    provider: sameProvider ? providerId : undefined,
    query,
    onlyVisible,
  })

  const download = async (pack: CatalogPack) => {
    try {
      await openMagnet(pack.magnet)
    } catch (cause) {
      showToast(String(cause))
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="los-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tx('Каталог паков', 'Pack catalog')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{tx('Обмен', 'Sharing')}</span>
            <h2>{tx('Каталог паков', 'Pack catalog')}</h2>
          </div>
          <button
            type="button"
            className="onboarding-close"
            onClick={onClose}
            aria-label={tx('Закрыть', 'Close')}
          >
            <X size={15} />
          </button>
        </header>

        <p className="settings-hint">
          {tx(
            'Статический каталог метаданных: паки качаются торрентом. Настройте URL, если используете зеркало или свой каталог.',
            'Static metadata catalog: packs are downloaded over BitTorrent. Set another URL for a mirror or your own catalog.',
          )}
        </p>
        <div className="marker-actions">
          <input
            className="catalog-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            spellCheck={false}
            aria-label={tx('URL каталога', 'Catalog URL')}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void load()}
          >
            {busy ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            {tx('Загрузить', 'Load')}
          </button>
        </div>

        <div className="layer-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tx('Поиск по имени, лицензии, издателю', 'Search by name, licence or publisher')}
            aria-label={tx('Поиск по каталогу', 'Search catalog')}
          />
        </div>
        <label className="source-check">
          <input
            type="checkbox"
            checked={onlyVisible}
            onChange={(event) => setOnlyVisible(event.target.checked)}
          />
          {tx('Только в текущем виде', 'Only in the current view')}
        </label>
        <label className="source-check">
          <input
            type="checkbox"
            checked={sameProvider}
            onChange={(event) => setSameProvider(event.target.checked)}
          />
          {tx('Только активный провайдер: {p0}', 'Only the active provider: {p0}', {
            p0: providerId,
          })}
        </label>

        {error && <p className="georef-error">{error}</p>}
        <p className="settings-hint">
          {tx('Найдено: {p0}', 'Found: {p0}', { p0: visible.length })}
        </p>
        {visible.length === 0 && !busy && !error && (
          <p className="pack-empty">
            {tx('В каталоге нет паков для этого вида', 'No packs for this view')}
          </p>
        )}
        <div className="catalog-list">
          {visible.map((pack) => (
            <div className="catalog-row" key={pack.id}>
              <div>
                <strong>{pack.name}</strong>
                <span className="muted">
                  {pack.provider} · z{pack.zoom[0]}–z{pack.zoom[1]} · {size(pack.bytes)} · {pack.license}
                </span>
                <code>
                  {pack.bbox.map((value) => value.toFixed(2)).join(', ')} · {pack.publisher}
                </code>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void download(pack)}
              >
                <Download size={14} />
                {tx('Скачать', 'Download')}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
