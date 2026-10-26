import { useEffect, useRef, useState } from 'react'
import { Download, RefreshCw, Trash2, X } from 'lucide-react'
import { useText } from './i18n'
import { readTextFile } from './native'
import { parseTracksFromGpx } from './featureTransfer'
import { useAppStore } from './store'
import {
  deleteTrack,
  forgetTrack,
  listTracks,
  markTrackImported,
  tracksFolder,
  type TrackFile,
} from './tracks'
import { useDialogFocus } from './useDialogFocus'

interface TracksPanelProps {
  onClose: () => void
}

const when = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  })

const size = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} kB`

/** Inbox of GPX tracks uploaded from the phone. */
export function TracksPanel({ onClose }: TracksPanelProps) {
  const tx = useText()
  const addFeatures = useAppStore((state) => state.addFeatures)
  const showToast = useAppStore((state) => state.showToast)
  const dialogRef = useRef<HTMLElement | null>(null)
  useDialogFocus(dialogRef, onClose)
  const [files, setFiles] = useState<TrackFile[]>([])
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setFiles(await listTracks())
    setFolder(await tracksFolder())
  }

  useEffect(() => {
    void load()
  }, [])

  const importFile = async (file: TrackFile) => {
    setBusy(true)
    try {
      const parsed = parseTracksFromGpx(await readTextFile(file.path))
      if (parsed.features.length === 0) {
        showToast(tx('В файле нет трека', 'No track in this file'))
        return
      }
      addFeatures(parsed.features)
      markTrackImported(file.path)
      showToast(
        tx('Импортировано: {p0}', 'Imported: {p0}', {
          p0: parsed.features[0]?.name ?? file.name,
        }),
      )
    } catch (error) {
      showToast(String(error))
    } finally {
      setBusy(false)
    }
  }

  const importAll = async () => {
    for (const file of files) await importFile(file)
  }

  const remove = async (file: TrackFile) => {
    if (!window.confirm(tx('Удалить трек {p0}?', 'Delete track {p0}?', { p0: file.name }))) {
      return
    }
    setBusy(true)
    try {
      await deleteTrack(file.path)
      forgetTrack(file.path)
      await load()
      showToast(tx('Файл удалён', 'File deleted'))
    } catch (error) {
      showToast(String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="los-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tx('Треки с телефона', 'Tracks from the phone')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{tx('Поле', 'Field')}</span>
            <h2>{tx('Треки с телефона', 'Tracks from the phone')}</h2>
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

        <div className="los-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void load()}>
            <RefreshCw size={14} />
            {tx('Обновить', 'Refresh')}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || files.length === 0}
            onClick={() => void importAll()}
          >
            <Download size={15} />
            {tx('Импортировать все', 'Import all')}
          </button>
        </div>

        {folder && <p className="settings-hint">{folder}</p>}

        {files.length === 0 ? (
          <p className="settings-hint">
            {tx(
              'Треков нет. Запишите трек на телефоне и отправьте на ноутбук.',
              'No tracks yet. Record one on the phone and send it to the laptop.',
            )}
          </p>
        ) : (
          <ul className="sync-list">
            {files.map((file) => (
              <li key={file.path}>
                <span>
                  {file.name}
                  <br />
                  <span className="muted">
                    {when(file.modified)} · {size(file.size)}
                  </span>
                </span>
                <span className="track-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={busy}
                    onClick={() => void importFile(file)}
                  >
                    {tx('Импортировать', 'Import')}
                  </button>
                  <button
                    type="button"
                    className="ghost-button is-danger"
                    disabled={busy}
                    onClick={() => void remove(file)}
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="settings-hint">
          {tx(
            'Новые треки за последние 7 дней импортируются автоматически; здесь можно добрать старые и удалить лишние.',
            'New tracks from the last 7 days import automatically; use this list for older files and cleanup.',
          )}
        </p>
      </section>
    </div>
  )
}
