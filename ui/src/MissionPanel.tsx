import { useMemo, useRef, useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { Download, Send, X } from 'lucide-react'
import { useText } from './i18n'
import { useAppStore } from './store'
import { writeBinaryFile, writeTextFile } from './native'
import { missionKml, missionKmz, qgcPlan, surveyWaypoints, type MissionPoint } from './mission'
import { useDialogFocus } from './useDialogFocus'

interface MissionPanelProps {
  onClose: () => void
}

/** Exports markers as a QGC plan or a KML/KMZ flight line. */
export function MissionPanel({ onClose }: MissionPanelProps) {
  const tx = useText()
  const markers = useAppStore((state) => state.markers)
  const features = useAppStore((state) => state.features)
  const showToast = useAppStore((state) => state.showToast)
  const dialogRef = useRef<HTMLElement | null>(null)
  useDialogFocus(dialogRef, onClose)

  const folders = useMemo(
    () => [...new Set(markers.map((marker) => marker.folder ?? ''))].sort(),
    [markers],
  )
  const [folder, setFolder] = useState<string>('')
  const [altitude, setAltitude] = useState(100)
  const [mode, setMode] = useState<'agl' | 'asl'>('agl')
  const [name, setName] = useState('Mappa mission')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [geofenceRadius, setGeofenceRadius] = useState(0)
  const [polygonId, setPolygonId] = useState('')
  const [spacing, setSpacing] = useState(100)

  const polygons = useMemo(
    () => features.filter((feature) => feature.kind === 'polygon'),
    [features],
  )
  const points: MissionPoint[] = useMemo(() => {
    if (polygonId) {
      const polygon = features.find((feature) => feature.id === polygonId)
      if (!polygon) return []
      try {
        return surveyWaypoints(polygon.coordinates, spacing).map(([lon, lat], index) => ({
          name: `WP ${index + 1}`,
          lon,
          lat,
          alt: altitude,
        }))
      } catch {
        return []
      }
    }
    return markers
      .filter((marker) => (folder === '' ? true : (marker.folder ?? '') === folder))
      .map((marker) => ({
        name: marker.name,
        lon: marker.lon,
        lat: marker.lat,
        alt: altitude,
      }))
  }, [markers, features, folder, altitude, polygonId, spacing])

  const exportFile = async (kind: 'plan' | 'kml' | 'kmz') => {
    if (points.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const target = await save({
        title: tx('Экспорт миссии', 'Export the mission'),
        defaultPath:
          kind === 'plan'
            ? 'mission.plan'
            : kind === 'kml'
              ? 'mission.kml'
              : 'mission.kmz',
        filters: [
          kind === 'plan'
            ? { name: 'QGroundControl plan', extensions: ['plan'] }
            : kind === 'kml'
              ? { name: 'KML', extensions: ['kml'] }
              : { name: 'KMZ', extensions: ['kmz'] },
        ],
      })
      if (typeof target !== 'string') return
      if (kind === 'plan') {
        await writeTextFile(
          target,
          qgcPlan(points, { name, mode, geofenceRadiusM: geofenceRadius }),
        )
      } else if (kind === 'kml') {
        await writeTextFile(target, missionKml(points, name, mode))
      } else {
        await writeBinaryFile(target, missionKmz(points, name, mode))
      }
      showToast(
        tx('Миссия сохранена: {p0}', 'Mission saved: {p0}', { p0: target }),
      )
      onClose()
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
        className="mission-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tx('Миссия', 'Mission')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{tx('Планирование', 'Planning')}</span>
            <h2>{tx('Миссия из меток', 'Mission from markers')}</h2>
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
            'Без полигона каждая метка становится путевой точкой. С полигоном строится «змейка» с заданным шагом линий. Высота общая; для QGC это AGL или ASL.',
            'Without a polygon every marker becomes a waypoint. With a polygon a lawnmower grid is built with the given line spacing. One altitude for all points; QGC treats it as AGL or ASL.',
          )}
        </p>

        <div className="los-grid">
          <label>
            <span>{tx('Папка', 'Folder')}</span>
            <select value={folder} onChange={(event) => setFolder(event.target.value)}>
              <option value="">{tx('Все метки', 'All markers')}</option>
              {folders.map((value) => (
                <option key={value} value={value}>
                  {value || tx('Без папки', 'No folder')}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{tx('Высота, м', 'Altitude, m')}</span>
            <input
              type="number"
              min={1}
              max={5000}
              value={altitude}
              onChange={(event) => setAltitude(Number(event.target.value))}
            />
          </label>
          <label>
            <span>{tx('Режим высоты', 'Altitude mode')}</span>
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value as 'agl' | 'asl')}
            >
              <option value="agl">{tx('AGL — над рельефом', 'AGL — above terrain')}</option>
              <option value="asl">{tx('ASL — над морем', 'ASL — above sea level')}</option>
            </select>
          </label>
          <label>
            <span>{tx('Геозона, м', 'Geofence, m')}</span>
            <input
              type="number"
              min={0}
              max={50000}
              step={100}
              value={geofenceRadius}
              onChange={(event) => setGeofenceRadius(Number(event.target.value))}
            />
          </label>
          <label>
            <span>{tx('Полигон-съёмка', 'Survey polygon')}</span>
            <select value={polygonId} onChange={(event) => setPolygonId(event.target.value)}>
              <option value="">{tx('Нет', 'None')}</option>
              {polygons.map((feature) => (
                <option key={feature.id} value={feature.id}>
                  {feature.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{tx('Шаг линий, м', 'Line spacing, m')}</span>
            <input
              type="number"
              min={5}
              max={5000}
              step={5}
              value={spacing}
              disabled={!polygonId}
              onChange={(event) => setSpacing(Number(event.target.value))}
            />
          </label>
          <label>
            <span>{tx('Название', 'Name')}</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        </div>

        <p className="settings-hint">
          {tx('Точек в миссии: {p0}', 'Waypoints in the mission: {p0}', {
            p0: points.length,
          })}
        </p>

        <div className="los-actions">
          <button
            type="button"
            className="primary-button"
            disabled={busy || points.length === 0}
            onClick={() => void exportFile('plan')}
          >
            <Send size={15} />
            {tx('QGC .plan', 'QGC .plan')}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || points.length === 0}
            onClick={() => void exportFile('kml')}
          >
            <Download size={15} />
            {tx('KML', 'KML')}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || points.length === 0}
            onClick={() => void exportFile('kmz')}
          >
            <Download size={15} />
            {tx('KMZ', 'KMZ')}
          </button>
        </div>

        {error && <p className="georef-error">{error}</p>}

        <p className="settings-hint">
          {tx(
            'Это не замена QGC: трек и миссию всё равно проверяйте в планировщике автопилота. Геозоны и полигоны-съёмки — следующий шаг.',
            'This is not a replacement for QGC: always review the mission in the autopilot planner. Geofences and survey polygons come next.',
          )}
        </p>
      </section>
    </div>
  )
}
