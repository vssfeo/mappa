import { useRef, useState } from 'react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { CloudDownload, CloudUpload, RefreshCw, X } from 'lucide-react'
import { useText } from './i18n'
import { isNative } from './native'
import { currentProjectSnapshot, applyProject } from './projectTransfer'
import { parseProject } from './projectFile'
import { useAppStore } from './store'
import { listProjects, pullProject, pushProject, type SyncEnvelope } from './sync'
import { useDialogFocus } from './useDialogFocus'

interface SyncPanelProps {
  map: MapLibreMap | null
  onClose: () => void
}

/** Push and pull a project through `mappa serve` with last-write-wins. */
export function SyncPanel({ map, onClose }: SyncPanelProps) {
  const tx = useText()
  const projectName = useAppStore((state) => state.projectName)
  const showToast = useAppStore((state) => state.showToast)
  const dialogRef = useRef<HTMLElement | null>(null)
  useDialogFocus(dialogRef, onClose)
  const [url, setUrl] = useState('http://127.0.0.1:8080')
  const [token, setToken] = useState('')
  const [name, setName] = useState(projectName)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [conflict, setConflict] = useState<SyncEnvelope | null>(null)
  const [remote, setRemote] = useState<{ name: string; version: number }[] | null>(null)

  const report = (error: unknown) =>
    setMessage(error instanceof Error ? error.message : String(error))

  const push = async (force = false) => {
    if (!isNative) {
      setMessage(tx('Синхронизация доступна в настольном приложении', 'Team sync is available in the desktop app'))
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const project = currentProjectSnapshot(name)
      const result = await pushProject(
        url,
        token,
        name,
        project as unknown as Record<string, unknown>,
        force,
      )
      if ('conflict' in result) {
        setConflict(result.conflict)
        setMessage(
          tx(
            'На сервере более новая версия. Заберите её или отправьте принудительно.',
            'The server has a newer version. Pull it or force push.',
          ),
        )
      } else {
        setConflict(null)
        setMessage(tx('Отправлено, версия {p0}', 'Pushed, version {p0}', { p0: result.version }))
      }
    } catch (error) {
      report(error)
    } finally {
      setBusy(false)
    }
  }

  const pull = async () => {
    if (!isNative) {
      setMessage(tx('Синхронизация доступна в настольном приложении', 'Team sync is available in the desktop app'))
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const envelope = await pullProject(url, token, name)
      if (!envelope) {
        setMessage(tx('На сервере нет такого проекта', 'No such project on the server'))
        return
      }
      const parsed = parseProject(JSON.stringify(envelope.project))
      await applyProject(parsed.file, parsed.features, null, map)
      setMessage(
        tx('Получено, версия {p0}', 'Pulled, version {p0}', { p0: envelope.version }),
      )
      showToast(tx('Проект синхронизирован', 'Project synced'))
    } catch (error) {
      report(error)
    } finally {
      setBusy(false)
    }
  }

  const check = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const projects = await listProjects(url, token)
      setRemote(projects)
      setMessage(
        tx('Проектов на сервере: {p0}', 'Projects on the server: {p0}', { p0: projects.length }),
      )
    } catch (error) {
      report(error)
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
        aria-label={tx('Командная синхронизация', 'Team sync')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{tx('Команда', 'Team')}</span>
            <h2>{tx('Командная синхронизация', 'Team sync')}</h2>
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

        <div className="los-grid">
          <label>
            <span>{tx('Сервер', 'Server')}</span>
            <input value={url} onChange={(event) => setUrl(event.target.value)} />
          </label>
          <label>
            <span>{tx('Токен', 'Token')}</span>
            <input
              value={token}
              placeholder={tx('необязательно', 'optional')}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <label>
            <span>{tx('Проект', 'Project')}</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
        </div>

        <div className="los-actions">
          <button type="button" className="primary-button" disabled={busy} onClick={() => void push()}>
            <CloudUpload size={15} />
            {tx('Отправить', 'Push')}
          </button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void pull()}>
            <CloudDownload size={15} />
            {tx('Забрать', 'Pull')}
          </button>
          <button type="button" className="ghost-button" disabled={busy} onClick={() => void check()}>
            <RefreshCw size={14} />
            {tx('Проверить сервер', 'Check server')}
          </button>
          {conflict && (
            <button
              type="button"
              className="ghost-button is-danger"
              disabled={busy}
              onClick={() => void push(true)}
            >
              {tx('Отправить принудительно', 'Force push')}
            </button>
          )}
        </div>

        {message && <p className="georef-ok">{message}</p>}
        {remote && remote.length > 0 && (
          <ul className="sync-list">
            {remote.map((item) => (
              <li key={item.name}>
                <span>{item.name}</span>
                <span>
                  {tx('версия {p0}', 'version {p0}', { p0: item.version })}
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="settings-hint">
          {tx(
            'LWW по времени сохранения: более новая версия побеждает. Обмен идёт напрямую с mappa serve в локальной сети, без облака и аккаунта.',
            'LWW by save time: the newer version wins. Sync talks to mappa serve over the local network, with no cloud or account.',
          )}
        </p>
      </section>
    </div>
  )
}
