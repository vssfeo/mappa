import { useEffect, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { FolderOpen, Play, Satellite, Square, X } from 'lucide-react'
import { featureId } from './features.ts'
import { useText } from './i18n.ts'
import {
  MERA_PROFILES,
  meraPpkCancel,
  meraPpkRun,
  meraPpkStatus,
  onMeraProgress,
  parseMeraGeoJsonTrack,
  type MeraPpkResult,
  type MeraProfile,
  type MeraProgressEvent,
  type MeraStatus,
} from './mera.ts'
import { readTextFile } from './native.ts'
import { useAppStore } from './store.ts'
import { useDialogFocus } from './useDialogFocus.ts'

interface MeraPanelProps {
  onClose: () => void
  onCenter: (lon: number, lat: number) => void
}

const MAX_QUALITY_SEGMENTS = 40

/** Offline GNSS RTK/PPK post-processing panel backed by the MERA sidecar. */
export function MeraPanel({ onClose, onCenter }: MeraPanelProps) {
  const tx = useText()
  const showToast = useAppStore((state) => state.showToast)
  const addFeatures = useAppStore((state) => state.addFeatures)
  const dialogRef = useRef<HTMLElement | null>(null)
  useDialogFocus(dialogRef, onClose)

  const [status, setStatus] = useState<MeraStatus | null>(null)
  const [roverPath, setRoverPath] = useState('')
  const [basePath, setBasePath] = useState('')
  const [navPath, setNavPath] = useState('')
  const [atxPath, setAtxPath] = useState('')
  const [antBase, setAntBase] = useState('TRM57971.00')
  const [outDir, setOutDir] = useState('')
  const [profile, setProfile] = useState<MeraProfile>('core-postprocess')
  const [elevMaskDeg, setElevMaskDeg] = useState(10)
  const [cn0MinDbHz, setCn0MinDbHz] = useState(30)
  const [emitNmea, setEmitNmea] = useState(true)
  const [autoLoadTrack, setAutoLoadTrack] = useState(true)

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<MeraProgressEvent | null>(null)
  const [result, setResult] = useState<MeraPpkResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void meraPpkStatus().then((next) => {
      if (alive) setStatus(next)
    })
    let unlisten: (() => void) | null = null
    void onMeraProgress((event) => {
      if (alive) setProgress(event)
    }).then((fn) => {
      if (alive) {
        unlisten = fn
      } else {
        fn()
      }
    })
    return () => {
      alive = false
      unlisten?.()
    }
  }, [])

  const pickFile = async (
    title: string,
    extensions: string[],
    setter: (path: string) => void,
  ) => {
    const selected = await open({
      title,
      multiple: false,
      filters: [{ name: title, extensions }],
    })
    if (typeof selected === 'string') setter(selected)
  }

  const pickDirectory = async () => {
    const selected = await open({
      title: tx('Папка для результатов PPK', 'PPK output directory'),
      directory: true,
      multiple: false,
    })
    if (typeof selected === 'string') setOutDir(selected)
  }

  const loadResultToMap = async (res: MeraPpkResult) => {
    const raw = await readTextFile(res.outGeojson)
    const parsed = parseMeraGeoJsonTrack(raw)
    if (parsed.allCoordinates.length < 2) {
      showToast(tx('Трек MERA пуст', 'MERA track is empty'))
      return
    }

    const summaryDesc = tx(
      'MERA ({p0}): фиксировано {p1}%, σH={p2} м',
      'MERA ({p0}): fixed {p1}%, σH={p2} m',
      {
        p0: res.summary.profile,
        p1: res.summary.fixedSharePct.toFixed(1),
        p2: res.summary.medianSigmaH_m.toFixed(3),
      },
    )

    if (
      parsed.segments.length > 0 &&
      parsed.segments.length <= MAX_QUALITY_SEGMENTS
    ) {
      addFeatures(
        parsed.segments.map((seg, idx) => ({
          id: featureId(),
          name:
            seg.quality === 'FIXED'
              ? tx('MERA PPK Fixed #{p0}', 'MERA PPK Fixed #{p0}', {
                  p0: idx + 1,
                })
              : tx('MERA PPK Float #{p0}', 'MERA PPK Float #{p0}', {
                  p0: idx + 1,
                }),
          kind: 'line' as const,
          coordinates: seg.coordinates,
          color: seg.quality === 'FIXED' ? '#10b981' : '#f59e0b',
          description: summaryDesc,
        })),
      )
    } else {
      addFeatures([
        {
          id: featureId(),
          name: tx('Трек MERA PPK ({p0})', 'MERA PPK track ({p0})', {
            p0: res.summary.profile,
          }),
          kind: 'line',
          coordinates: parsed.allCoordinates,
          color: '#10b981',
          description: summaryDesc,
        },
      ])
    }

    if (parsed.center) {
      onCenter(parsed.center[0], parsed.center[1])
    }
    showToast(
      tx(
        'Трек MERA добавлен: {p0} эпох ({p1}% fixed)',
        'MERA track added: {p0} epochs ({p1}% fixed)',
        {
          p0: parsed.points,
          p1: res.summary.fixedSharePct.toFixed(1),
        },
      ),
    )
  }

  const run = async () => {
    if (!roverPath.trim() || !basePath.trim() || !navPath.trim() || !outDir.trim()) {
      setError(
        tx(
          'Укажите файлы rover, base, nav и папку для результатов.',
          'Select rover, base, nav files and an output directory.',
        ),
      )
      return
    }
    setRunning(true)
    setError(null)
    setResult(null)
    setProgress(null)
    try {
      const res = await meraPpkRun({
        roverPath: roverPath.trim(),
        basePath: basePath.trim(),
        navPath: navPath.trim(),
        atxPath: atxPath.trim() || null,
        antBase: antBase.trim() || null,
        profile,
        elevMaskDeg,
        cn0MinDbHz,
        outDir: outDir.trim(),
        emitNmea,
      })
      setResult(res)
      if (autoLoadTrack) {
        await loadResultToMap(res)
      }
    } catch (cause) {
      setError(String(cause))
    } finally {
      setRunning(false)
      setStatus(await meraPpkStatus())
    }
  }

  const cancel = async () => {
    try {
      await meraPpkCancel()
    } catch (cause) {
      setError(String(cause))
    }
  }

  const progressPct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.epoch / progress.total) * 100))
      : 0

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="mission-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tx('MERA RTK/PPK', 'MERA RTK/PPK')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">GNSS · MERA</span>
            <h2>{tx('Постобработка MERA RTK/PPK', 'MERA RTK/PPK post-processing')}</h2>
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

        {status && !status.available && (
          <p className="georef-error">
            {tx(
              'Бинарь mera-rtk не найден. Соберите его скриптом scripts/build_mera_sidecar.sh или задайте MERA_RTK_BIN.',
              'mera-rtk binary not found. Build it with scripts/build_mera_sidecar.sh or set MERA_RTK_BIN.',
            )}
          </p>
        )}

        <div className="los-grid">
          <label>
            <span>{tx('Rover RINEX (.obs)', 'Rover RINEX (.obs)')}</span>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                value={roverPath}
                disabled={running}
                placeholder="/path/to/rover.obs"
                onChange={(event) => setRoverPath(event.target.value)}
              />
              <button
                type="button"
                className="ghost-button"
                disabled={running}
                onClick={() =>
                  void pickFile('Rover RINEX', ['obs', '24o', '25o', '26o', 'rnx'], setRoverPath)
                }
                aria-label={tx('Выбрать rover', 'Pick rover')}
              >
                <FolderOpen size={14} />
              </button>
            </div>
          </label>

          <label>
            <span>{tx('Base RINEX (.obs)', 'Base RINEX (.obs)')}</span>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                value={basePath}
                disabled={running}
                placeholder="/path/to/base.obs"
                onChange={(event) => setBasePath(event.target.value)}
              />
              <button
                type="button"
                className="ghost-button"
                disabled={running}
                onClick={() =>
                  void pickFile('Base RINEX', ['obs', '24o', '25o', '26o', 'rnx'], setBasePath)
                }
                aria-label={tx('Выбрать base', 'Pick base')}
              >
                <FolderOpen size={14} />
              </button>
            </div>
          </label>

          <label>
            <span>{tx('Навигация RINEX (.nav)', 'Navigation RINEX (.nav)')}</span>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                value={navPath}
                disabled={running}
                placeholder="/path/to/base.nav"
                onChange={(event) => setNavPath(event.target.value)}
              />
              <button
                type="button"
                className="ghost-button"
                disabled={running}
                onClick={() =>
                  void pickFile('Navigation RINEX', ['nav', '24p', '25p', '26p', 'rnx'], setNavPath)
                }
                aria-label={tx('Выбрать nav', 'Pick nav')}
              >
                <FolderOpen size={14} />
              </button>
            </div>
          </label>

          <label>
            <span>{tx('Папка вывода', 'Output directory')}</span>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                value={outDir}
                disabled={running}
                placeholder="/tmp/mera-out"
                onChange={(event) => setOutDir(event.target.value)}
              />
              <button
                type="button"
                className="ghost-button"
                disabled={running}
                onClick={() => void pickDirectory()}
                aria-label={tx('Выбрать папку', 'Pick directory')}
              >
                <FolderOpen size={14} />
              </button>
            </div>
          </label>

          <label>
            <span>{tx('ANTEX (.atx, опционально)', 'ANTEX (.atx, optional)')}</span>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                value={atxPath}
                disabled={running}
                placeholder="igs20.atx"
                onChange={(event) => setAtxPath(event.target.value)}
              />
              <button
                type="button"
                className="ghost-button"
                disabled={running}
                onClick={() => void pickFile('ANTEX', ['atx'], setAtxPath)}
                aria-label={tx('Выбрать ANTEX', 'Pick ANTEX')}
              >
                <FolderOpen size={14} />
              </button>
            </div>
          </label>

          <label>
            <span>{tx('Антенна базы', 'Base antenna')}</span>
            <input
              value={antBase}
              disabled={running}
              onChange={(event) => setAntBase(event.target.value)}
            />
          </label>

          <label>
            <span>{tx('Профиль решателя', 'Solver profile')}</span>
            <select
              value={profile}
              disabled={running}
              onChange={(event) => setProfile(event.target.value as MeraProfile)}
            >
              {MERA_PROFILES.map((item) => (
                <option key={item.id} value={item.id}>
                  {tx(item.labelRu, item.labelEn)}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>{tx('Маска угла места (°)', 'Elevation mask (°)')}</span>
            <input
              type="number"
              min={0}
              max={45}
              step={1}
              value={elevMaskDeg}
              disabled={running}
              onChange={(event) => setElevMaskDeg(Number(event.target.value))}
            />
          </label>

          <label>
            <span>{tx('Порог C/N0 (dB-Hz)', 'Min C/N0 (dB-Hz)')}</span>
            <input
              type="number"
              min={10}
              max={50}
              step={1}
              value={cn0MinDbHz}
              disabled={running}
              onChange={(event) => setCn0MinDbHz(Number(event.target.value))}
            />
          </label>
        </div>

        <div className="los-actions" style={{ alignItems: 'center' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <input
              type="checkbox"
              checked={emitNmea}
              disabled={running}
              onChange={(event) => setEmitNmea(event.target.checked)}
            />
            <span>{tx('Экспорт NMEA (.nmea)', 'Export NMEA (.nmea)')}</span>
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <input
              type="checkbox"
              checked={autoLoadTrack}
              disabled={running}
              onChange={(event) => setAutoLoadTrack(event.target.checked)}
            />
            <span>{tx('Загрузить трек на карту', 'Load track onto map')}</span>
          </label>
        </div>

        <div className="los-actions">
          <button
            type="button"
            className="primary-button"
            disabled={running || (status !== null && !status.available)}
            onClick={() => void run()}
          >
            <Play size={15} />
            {running ? tx('Расчёт…', 'Solving…') : tx('Запустить PPK', 'Run PPK')}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!running}
            onClick={() => void cancel()}
          >
            <Square size={14} />
            {tx('Отмена', 'Cancel')}
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={!result || running}
            onClick={() => {
              if (result) void loadResultToMap(result)
            }}
          >
            <Satellite size={14} />
            {tx('Трек на карту', 'Track on map')}
          </button>
        </div>

        {running && progress && (
          <div style={{ marginTop: '8px' }}>
            <progress value={progressPct} max={100} style={{ width: '100%' }} />
            <p className="settings-hint">
              {tx(
                'Эпоха {p0}/{p1} ({p2}%) · Fixed: {p3}',
                'Epoch {p0}/{p1} ({p2}%) · Fixed: {p3}',
                {
                  p0: progress.epoch,
                  p1: progress.total,
                  p2: progressPct,
                  p3: progress.fixed,
                },
              )}
            </p>
          </div>
        )}

        {error && <p className="georef-error">{error}</p>}

        {result && (
          <p className="georef-ok">
            {tx(
              'Готово за {p0} с · эпох: {p1} · Fixed: {p2} ({p3}%) · медиана σH: {p4} м · режим: {p5}',
              'Done in {p0} s · epochs: {p1} · Fixed: {p2} ({p3}%) · median σH: {p4} m · mode: {p5}',
              {
                p0: result.summary.wallSeconds.toFixed(1),
                p1: result.summary.epochs,
                p2: result.summary.fixedEpochs,
                p3: result.summary.fixedSharePct.toFixed(1),
                p4: result.summary.medianSigmaH_m.toFixed(3),
                p5: result.summary.causalityMode,
              },
            )}
          </p>
        )}

        {status?.binaryPath && (
          <p className="settings-hint">
            {tx('Движок: {p0}', 'Engine: {p0}', { p0: status.binaryPath })}
          </p>
        )}
      </section>
    </div>
  )
}
