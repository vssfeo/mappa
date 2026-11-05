import { useMemo, useRef, useState } from 'react'
import { FolderOpen, Loader2, PackageOpen, X } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { useText } from './i18n'
import { useAppStore } from './store'
import { currentProjectSnapshot } from './projectTransfer'
import { serializeProject } from './projectFile'
import { useDialogFocus } from './useDialogFocus'
import { useViewStore } from './viewStore'
import { MAX_JOB_TILES, useDownloadsStore } from './downloads'
import { providerById } from './providers'
import { estimateDownload, formatBytes, formatCount } from './format'

interface FieldKitResult {
  directory: string
  files: { path: string; bytes: number; blake3: string }[]
}

interface VerifyFile {
  path: string
  ok: boolean
  error: string | null
}

interface VerifyResult {
  directory: string
  ok: boolean
  files: VerifyFile[]
  project: string | null
  packs: string[]
  dem: string | null
}

interface FieldKitPanelProps {
  onClose: () => void
}

/** Builds a folder with the project, packs and DEM for the field. */
export function FieldKitPanel({ onClose }: FieldKitPanelProps) {
  const tx = useText()
  const projectName = useAppStore((state) => state.projectName)
  const packs = useAppStore((state) => state.packs)
  const demPath = useAppStore((state) => state.demPath)
  const providerId = useAppStore((state) => state.providerId)
  const showToast = useAppStore((state) => state.showToast)
  const bounds = useViewStore((state) => state.mapView.bounds)
  const zoom = useViewStore((state) => state.mapView.zoom)
  const dialogRef = useRef<HTMLElement | null>(null)
  useDialogFocus(dialogRef, onClose)
  const [directory, setDirectory] = useState('')
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(packs.map((pack) => pack.path)),
  )
  const [includeProject, setIncludeProject] = useState(true)
  const [includeDem, setIncludeDem] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<FieldKitResult | null>(null)
  const [minZoom, setMinZoom] = useState(Math.max(0, Math.floor(zoom)))
  const [maxZoom, setMaxZoom] = useState(Math.min(19, Math.ceil(zoom) + 2))
  const [progress, setProgress] = useState<string | null>(null)
  const [verifyBusy, setVerifyBusy] = useState(false)
  const [verified, setVerified] = useState<VerifyResult | null>(null)
  const estimate = useMemo(
    () => estimateDownload(bounds, minZoom, maxZoom),
    [bounds, minZoom, maxZoom],
  )

  const chooseDirectory = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: tx('Куда собрать полевой комплект', 'Where to build the field kit'),
    })
    const path = Array.isArray(picked) ? picked[0] : picked
    if (typeof path === 'string') setDirectory(path)
  }

  const buildKit = async (extraPacks: string[] = []) => {
    const project = includeProject
      ? serializeProject(currentProjectSnapshot(projectName || 'Field kit'))
      : null
    const summary = await invoke<FieldKitResult>('export_field_kit', {
      request: {
        directory,
        project,
        packs: [
          ...packs
            .filter((pack) => selected.has(pack.path))
            .map((pack) => pack.path),
          ...extraPacks,
        ],
        dem: includeDem && demPath ? demPath : null,
      },
    })
    setResult(summary)
    showToast(
      tx('Полевой комплект собран: {p0}', 'Field kit built: {p0}', {
        p0: summary.directory,
      }),
    )
    return summary
  }

  const verifyKit = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: tx('Выберите папку полевого комплекта', 'Choose the field-kit folder'),
    })
    const path = Array.isArray(picked) ? picked[0] : picked
    if (typeof path !== 'string') return
    setVerifyBusy(true)
    setError(null)
    try {
      setVerified(
        await invoke<VerifyResult>('verify_field_kit', { directory: path }),
      )
    } catch (cause) {
      setError(String(cause))
    } finally {
      setVerifyBusy(false)
    }
  }

  const run = async () => {
    if (!directory) return
    setBusy(true)
    setError(null)
    try {
      await buildKit()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const runDownload = async () => {
    if (!directory || !bounds) return
    setBusy(true)
    setError(null)
    setProgress(tx('Создаю задание…', 'Creating the job…'))
    try {
      const [[west, south], [east, north]] = bounds
      const store = useDownloadsStore.getState()
      const job = await store.create({
        name: `${providerId} ${new Date().toISOString().slice(0, 10)}`,
        providerId,
        west,
        south,
        east,
        north,
        minZoom,
        maxZoom,
      })
      const deadline = Date.now() + 2 * 60 * 60 * 1000
      for (;;) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
        const current = useDownloadsStore
          .getState()
          .jobs.find((item) => item.id === job.id)
        if (!current) throw new Error('download job disappeared')
        setProgress(
          `${formatCount(current.doneTiles)} / ${formatCount(current.totalTiles)}`,
        )
        if (current.status === 'completed') break
        if (current.status === 'failed' || current.status === 'cancelled') {
          throw new Error(current.error || current.status)
        }
        if (Date.now() > deadline) throw new Error('download timed out')
      }
      setProgress(tx('Собираю пак…', 'Building the pack…'))
      const report = await store.exportJob(job.id, 'mbtiles')
      setProgress(tx('Собираю комплект…', 'Building the kit…'))
      await buildKit([report.path])
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="los-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tx('Полевой комплект', 'Field kit')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{tx('Поле', 'Field')}</span>
            <h2>{tx('Полевой комплект', 'Field kit')}</h2>
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
            'Собирает папку с проектом, паками и DEM, manifest с BLAKE3-контролем. Скопируйте её на USB или SD-карту.',
            'Builds a folder with the project, packs and DEM plus a BLAKE3 manifest. Copy it to USB or an SD card.',
          )}
        </p>
        <div className="marker-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void chooseDirectory()}
          >
            <FolderOpen size={14} />
            {tx('Выбрать папку', 'Choose folder')}
          </button>
          <span className="source-hint">{directory || tx('Папка не выбрана', 'No folder selected')}</span>
        </div>

        <div className="marker-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={verifyBusy}
            onClick={() => void verifyKit()}
          >
            {verifyBusy ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <FolderOpen size={14} />
            )}
            {tx('Проверить комплект', 'Verify kit')}
          </button>
        </div>
        {verified && (
          <div className="field-kit-result">
            <strong>
              {verified.ok
                ? tx('Комплект цел', 'Kit is intact')
                : tx('Есть расхождения', 'Checksum mismatch')}
            </strong>
            {verified.files.map((file) => (
              <span key={file.path} className={file.ok ? 'muted' : 'georef-error'}>
                {file.ok ? '✓' : '✕'} {file.path}
                {file.error ? ` — ${file.error}` : ''}
              </span>
            ))}
          </div>
        )}

        <div className="section-heading">
          <span>{tx('Скачать текущий вид', 'Download the current view')}</span>
          <span className="mono">{providerById(providerId)?.short ?? providerId}</span>
        </div>
        <div className="source-grid">
          <label>
            {tx('Мин. зум', 'Min zoom')}
            <input
              type="number"
              min="0"
              max="19"
              value={minZoom}
              onChange={(event) => setMinZoom(Number(event.target.value))}
            />
          </label>
          <label>
            {tx('Макс. зум', 'Max zoom')}
            <input
              type="number"
              min="0"
              max="19"
              value={maxZoom}
              onChange={(event) => setMaxZoom(Number(event.target.value))}
            />
          </label>
        </div>
        <p className="settings-hint">
          {tx(
            '{p0} тайлов · ≈ {p1}',
            '{p0} tiles · ≈ {p1}',
            { p0: formatCount(estimate.tiles), p1: formatBytes(estimate.bytes) },
          )}
        </p>
        <div className="marker-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={
              busy ||
              !directory ||
              !bounds ||
              estimate.tiles === 0 ||
              estimate.tiles > MAX_JOB_TILES
            }
            onClick={() => void runDownload()}
          >
            {busy && progress ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <PackageOpen size={14} />
            )}
            {tx('Скачать и собрать', 'Download and build')}
          </button>
          {progress && <span className="source-hint">{progress}</span>}
        </div>

        <label className="source-check">
          <input
            type="checkbox"
            checked={includeProject}
            onChange={(event) => setIncludeProject(event.target.checked)}
          />
          {tx('Проект .mappa', 'Project .mappa')}
        </label>
        {demPath && (
          <label className="source-check">
            <input
              type="checkbox"
              checked={includeDem}
              onChange={(event) => setIncludeDem(event.target.checked)}
            />
            {tx('DEM: {p0}', 'DEM: {p0}', { p0: demPath })}
          </label>
        )}
        {packs.length > 0 && (
          <>
            <p className="settings-hint">{tx('Паки', 'Packs')}</p>
            {packs.map((pack) => (
              <label key={pack.path} className="source-check">
                <input
                  type="checkbox"
                  checked={selected.has(pack.path)}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current)
                      if (next.has(pack.path)) next.delete(pack.path)
                      else next.add(pack.path)
                      return next
                    })
                  }
                />
                {pack.name}
              </label>
            ))}
          </>
        )}

        <div className="marker-actions">
          <button
            type="button"
            className="primary-button"
            disabled={busy || !directory}
            onClick={() => void run()}
          >
            {busy ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <PackageOpen size={14} />
            )}
            {tx('Собрать', 'Build')}
          </button>
          <button type="button" className="ghost-button" onClick={onClose}>
            {tx('Закрыть', 'Close')}
          </button>
        </div>

        {error && <p className="georef-error">{error}</p>}
        {result && (
          <div className="field-kit-result">
            <strong>{result.directory}</strong>
            <span className="muted">
              {tx('Файлов: {p0}', 'Files: {p0}', { p0: result.files.length })}
            </span>
            {result.files.map((file) => (
              <code key={file.path}>
                {file.path} · {Math.max(1, Math.round(file.bytes / 1024))} kB ·{' '}
                {file.blake3.slice(0, 12)}…
              </code>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
