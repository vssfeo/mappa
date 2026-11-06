import { useRef, useState } from 'react'
import { Copy, ExternalLink, Loader2, Share2, X } from 'lucide-react'
import { save } from '@tauri-apps/plugin-dialog'
import { useText } from './i18n'
import { useAppStore } from './store'
import { createPackTorrent, openMagnet, openUrl, type TorrentInfo } from './torrent'
import { catalogEntry, catalogIssueUrl } from './catalog'
import { useDialogFocus } from './useDialogFocus'

interface SharePanelProps {
  onClose: () => void
}

/** Creates a .torrent/magnet for a finished pack and opens a torrent client. */
export function SharePanel({ onClose }: SharePanelProps) {
  const tx = useText()
  const packs = useAppStore((state) => state.packs)
  const providerId = useAppStore((state) => state.providerId)
  const projectName = useAppStore((state) => state.projectName)
  const showToast = useAppStore((state) => state.showToast)
  const dialogRef = useRef<HTMLElement | null>(null)
  useDialogFocus(dialogRef, onClose)
  const [selected, setSelected] = useState(packs[0]?.path ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<TorrentInfo | null>(null)
  const [license, setLicense] = useState('')

  const buildEntry = () => {
    if (!info || !license.trim()) return null
    const pack = packs.find((item) => item.path === selected)
    if (!pack) return null
    return catalogEntry({
      pack: { ...pack, bytes: info.bytes },
      provider: providerId,
      infoHash: info.infoHash,
      magnet: info.magnet,
      license: license.trim(),
      publisher: projectName || 'mappa',
    })
  }

  const create = async () => {
    if (!selected) return
    const pack = packs.find((item) => item.path === selected)
    const destination = await save({
      title: tx('Сохранить торрент', 'Save torrent'),
      defaultPath: `${pack?.name ?? 'mappa-pack'}.torrent`,
      filters: [{ name: 'BitTorrent', extensions: ['torrent'] }],
    })
    if (typeof destination !== 'string') return
    setBusy(true)
    setError(null)
    try {
      setInfo(await createPackTorrent(selected, destination))
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const open = async () => {
    if (!info) return
    try {
      await openMagnet(info.magnet)
    } catch (cause) {
      setError(String(cause))
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="los-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tx('Поделиться паком', 'Share a pack')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{tx('Обмен', 'Sharing')}</span>
            <h2>{tx('Поделиться паком', 'Share a pack')}</h2>
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
            'Создаёт .torrent и magnet для готового пака. Скачивание выполняет ваш торрент-клиент. Ответственность за права на данные — на вас; Mappa не проверяет лицензии.',
            'Creates a .torrent and a magnet for a finished pack. Your torrent client does the download. You are responsible for the data rights; Mappa does not check licences.',
          )}
        </p>

        {packs.length === 0 ? (
          <p className="pack-empty">
            {tx('Нет открытых паков', 'No packs are open')}
          </p>
        ) : (
          <>
            <label>
              {tx('Пак', 'Pack')}
              <select
                value={selected}
                onChange={(event) => {
                  setSelected(event.target.value)
                  setInfo(null)
                }}
              >
                {packs.map((pack) => (
                  <option key={pack.path} value={pack.path}>
                    {pack.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="marker-actions">
              <button
                type="button"
                className="primary-button"
                disabled={busy || !selected}
                onClick={() => void create()}
              >
                {busy ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Share2 size={14} />
                )}
                {tx('Создать торрент', 'Create torrent')}
              </button>
            </div>
          </>
        )}

        {error && <p className="georef-error">{error}</p>}
        {info && (
          <div className="torrent-result">
            <strong>{info.name}</strong>
            <span className="muted">
              {tx('Размер: {p0} МиБ', 'Size: {p0} MiB', {
                p0: (info.bytes / 1024 / 1024).toFixed(1),
              })}
              {' · '}
              {tx('Кусок: {p0} КиБ', 'Piece: {p0} KiB', {
                p0: Math.round(info.pieceLength / 1024),
              })}
            </span>
            <code>info hash: {info.infoHash}</code>
            <code className="torrent-magnet">{info.magnet}</code>
            <div className="marker-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  void navigator.clipboard.writeText(info.magnet)
                  showToast(tx('Magnet скопирован', 'Magnet copied'))
                }}
              >
                <Copy size={14} />
                {tx('Копировать magnet', 'Copy magnet')}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void open()}
              >
                <ExternalLink size={14} />
                {tx('Открыть в торрент-клиенте', 'Open in torrent client')}
              </button>
            </div>
            <span className="muted">{info.torrent}</span>
            <label>
              {tx('Лицензия / источник', 'Licence / source')}
              <input
                value={license}
                onChange={(event) => setLicense(event.target.value)}
                placeholder="ODbL, public domain, own data…"
              />
            </label>
            <button
              type="button"
              className="ghost-button"
              disabled={license.trim().length === 0}
              onClick={() => {
                const entry = buildEntry()
                if (!entry) return
                void navigator.clipboard.writeText(
                  JSON.stringify(entry, null, 2),
                )
                showToast(
                  tx(
                    'Запись каталога скопирована — вставьте её в PR',
                    'Catalog entry copied — paste it into a PR',
                  ),
                )
              }}
            >
              <Copy size={14} />
              {tx('Скопировать запись каталога', 'Copy catalog entry')}
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={license.trim().length === 0}
              onClick={() => {
                const entry = buildEntry()
                if (entry) {
                  void openUrl(catalogIssueUrl(entry)).catch((cause) =>
                    setError(String(cause)),
                  )
                }
              }}
            >
              <ExternalLink size={14} />
              {tx('Открыть issue каталога', 'Open catalog issue')}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
