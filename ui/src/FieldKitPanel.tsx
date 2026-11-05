import { useRef, useState } from 'react'
import { FolderOpen, Loader2, PackageOpen, X } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { useText } from './i18n'
import { useAppStore } from './store'
import { currentProjectSnapshot } from './projectTransfer'
import { serializeProject } from './projectFile'
import { useDialogFocus } from './useDialogFocus'

interface FieldKitResult {
  directory: string
  files: { path: string; bytes: number; blake3: string }[]
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
  const showToast = useAppStore((state) => state.showToast)
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

  const chooseDirectory = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: tx('Куда собрать полевой комплект', 'Where to build the field kit'),
    })
    const path = Array.isArray(picked) ? picked[0] : picked
    if (typeof path === 'string') setDirectory(path)
  }

  const run = async () => {
    if (!directory) return
    setBusy(true)
    setError(null)
    try {
      const project = includeProject
        ? serializeProject(currentProjectSnapshot(projectName || 'Field kit'))
        : null
      const summary = await invoke<FieldKitResult>('export_field_kit', {
        request: {
          directory,
          project,
          packs: packs
            .filter((pack) => selected.has(pack.path))
            .map((pack) => pack.path),
          dem: includeDem && demPath ? demPath : null,
        },
      })
      setResult(summary)
      showToast(
        tx('Полевой комплект собран: {p0}', 'Field kit built: {p0}', {
          p0: summary.directory,
        }),
      )
    } catch (cause) {
      setError(String(cause))
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
