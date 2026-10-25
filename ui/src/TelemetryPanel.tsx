import { useEffect, useRef, useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { LocateFixed, RadioTower, Trash2, X } from 'lucide-react'
import { useText } from './i18n'
import { useAppStore } from './store'
import { featureId } from './features'
import { writeTextFile } from './native'
import {
  mavlinkClear,
  mavlinkStatus,
  mavlinkTrack,
  startMavlink,
  stopMavlink,
  telemetryGpx,
  type TelemetryStatus,
} from './telemetry'
import { useDialogFocus } from './useDialogFocus'

interface TelemetryPanelProps {
  onClose: () => void
  onCenter: (lon: number, lat: number) => void
}

/** Receive-only MAVLink monitor: position, heading, track and GPX. */
export function TelemetryPanel({ onClose, onCenter }: TelemetryPanelProps) {
  const tx = useText()
  const showToast = useAppStore((state) => state.showToast)
  const addFeatures = useAppStore((state) => state.addFeatures)
  const dialogRef = useRef<HTMLElement | null>(null)
  useDialogFocus(dialogRef, onClose)
  const [port, setPort] = useState(14550)
  const [status, setStatus] = useState<TelemetryStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const tick = async () => {
      const next = await mavlinkStatus()
      if (alive) setStatus(next)
    }
    void tick()
    const timer = setInterval(() => void tick(), 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      await startMavlink(port)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    try {
      await stopMavlink()
    } finally {
      setBusy(false)
    }
  }

  const drawTrack = async () => {
    const points = await mavlinkTrack()
    if (points.length < 2) {
      showToast(tx('Трек пуст', 'The track is empty'))
      return
    }
    addFeatures([
      {
        id: featureId(),
        name: tx('Трек MAVLink', 'MAVLink track'),
        kind: 'line',
        coordinates: points.map((point) => [point.lon, point.lat] as [number, number]),
        color: '#43d9c5',
        description: tx('Точек: {p0}', 'Points: {p0}', { p0: points.length }),
      },
    ])
    showToast(
      tx('Трек добавлен на карту: {p0} точек', 'Track added: {p0} points', {
        p0: points.length,
      }),
    )
    onClose()
  }

  const exportGpx = async () => {
    const points = await mavlinkTrack()
    if (points.length === 0) {
      showToast(tx('Трек пуст', 'The track is empty'))
      return
    }
    const target = await save({
      title: tx('Сохранить трек GPX', 'Save the GPX track'),
      defaultPath: 'mavlink-track.gpx',
      filters: [{ name: 'GPX', extensions: ['gpx'] }],
    })
    if (typeof target !== 'string') return
    await writeTextFile(target, telemetryGpx(points))
    showToast(tx('Трек сохранён: {p0}', 'Track saved: {p0}', { p0: target }))
  }

  const clear = async () => {
    await mavlinkClear()
    setStatus(await mavlinkStatus())
  }

  const fix = status?.fix ?? null
  const heartbeatAge =
    status?.lastHeartbeatMs != null
      ? Math.round((Date.now() - status.lastHeartbeatMs) / 1000)
      : null

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="mission-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tx('Телеметрия MAVLink', 'MAVLink telemetry')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{tx('Телеметрия', 'Telemetry')}</span>
            <h2>{tx('Телеметрия MAVLink', 'MAVLink telemetry')}</h2>
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
            <span>{tx('UDP-порт', 'UDP port')}</span>
            <input
              type="number"
              min={1024}
              max={65535}
              value={port}
              disabled={status?.running}
              onChange={(event) => setPort(Number(event.target.value))}
            />
          </label>
          <label>
            <span>{tx('Состояние', 'State')}</span>
            <input
              readOnly
              value={
                status?.running
                  ? tx('Приём', 'Receiving')
                  : tx('Остановлено', 'Stopped')
              }
            />
          </label>
          <label>
            <span>{tx('Пакетов', 'Frames')}</span>
            <input readOnly value={status?.frames ?? 0} />
          </label>
          <label>
            <span>{tx('Точек трека', 'Track points')}</span>
            <input readOnly value={status?.trackPoints ?? 0} />
          </label>
        </div>

        <div className="los-actions">
          <button
            type="button"
            className="primary-button"
            disabled={busy || status?.running}
            onClick={() => void start()}
          >
            <RadioTower size={15} />
            {tx('Слушать UDP', 'Listen on UDP')}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !status?.running}
            onClick={() => void stop()}
          >
            {tx('Стоп', 'Stop')}
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={!fix}
            onClick={() => fix && onCenter(fix.lon, fix.lat)}
          >
            <LocateFixed size={14} />
            {tx('В центр', 'Centre')}
          </button>
          <button type="button" className="ghost-button" onClick={() => void drawTrack()}>
            {tx('Трек на карту', 'Track on the map')}
          </button>
          <button type="button" className="ghost-button" onClick={() => void exportGpx()}>
            {tx('GPX', 'GPX')}
          </button>
          <button type="button" className="ghost-button is-danger" onClick={() => void clear()}>
            <Trash2 size={14} />
            {tx('Очистить', 'Clear')}
          </button>
        </div>

        {error && <p className="georef-error">{error}</p>}

        {fix ? (
          <p className="georef-ok">
            {fix.lat.toFixed(6)}, {fix.lon.toFixed(6)} · {tx('высота', 'altitude')}{' '}
            {fix.altM.toFixed(0)} {tx('м', 'm')} · {tx('курс', 'heading')}{' '}
            {fix.headingDeg.toFixed(0)}°
            {heartbeatAge !== null && (
              <>
                {' · '}
                {tx('heartbeat {p0} с назад', 'heartbeat {p0} s ago', {
                  p0: heartbeatAge,
                })}
              </>
            )}
          </p>
        ) : (
          <p className="settings-hint">
            {tx(
              'Нет данных. Включите телеметрию на борту или запустите SITL и отправьте поток на этот порт.',
              'No data yet. Enable telemetry on the vehicle or start SITL and send the stream to this port.',
            )}
          </p>
        )}

        <p className="settings-hint">
          {tx(
            'Только приём: команды на борт не отправляются. Поддерживаются MAVLink v1/v2, GLOBAL_POSITION_INT и HEARTBEAT; CRC проверяется.',
            'Receive only: nothing is sent to the vehicle. MAVLink v1/v2, GLOBAL_POSITION_INT and HEARTBEAT are supported; the CRC is verified.',
          )}
        </p>
      </section>
    </div>
  )
}
