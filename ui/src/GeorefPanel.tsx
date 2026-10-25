import { useEffect, useRef, useState } from 'react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { Crosshair, FileImage, Save, Trash2, X } from 'lucide-react'
import { readBinaryFile } from './native'
import { useText } from './i18n'
import { useAppStore } from './store'
import { useViewStore } from './viewStore'
import { solveGeoref, warpScan, type Gcp, type GeorefModel, type GeorefSolution } from './georef'
import { useDialogFocus } from './useDialogFocus'

interface Scan {
  path: string
  url: string
  width: number
  height: number
}

interface GeorefPanelProps {
  onClose: () => void
}

/** Georeferences a scanned map from ground control points into a COG. */
export function GeorefPanel({ onClose }: GeorefPanelProps) {
  const tx = useText()
  const showToast = useAppStore((state) => state.showToast)
  const center = useViewStore((state) => state.mapView.center)
  const dialogRef = useRef<HTMLElement | null>(null)
  const [scan, setScan] = useState<Scan | null>(null)
  const [gcps, setGcps] = useState<Gcp[]>([])
  const [solution, setSolution] = useState<GeorefSolution | null>(null)
  const [model, setModel] = useState<GeorefModel>('affine')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useDialogFocus(dialogRef, onClose)

  useEffect(
    () => () => {
      if (scan) URL.revokeObjectURL(scan.url)
    },
    [scan],
  )

  const pickScan = async () => {
    setError(null)
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: tx('Открыть скан карты', 'Open a map scan'),
        filters: [{ name: 'PNG / JPEG / TIFF', extensions: ['png', 'jpg', 'jpeg', 'tif', 'tiff'] }],
      })
      const path = Array.isArray(selected) ? selected[0] : selected
      if (typeof path !== 'string') return
      const bytes = await readBinaryFile(path)
      const url = URL.createObjectURL(new Blob([bytes]))
      const image = new Image()
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('cannot read the image'))
        image.src = url
      })
      if (scan) URL.revokeObjectURL(scan.url)
      setScan({ path, url, width: image.naturalWidth, height: image.naturalHeight })
      setGcps([])
      setSolution(null)
    } catch (cause) {
      setError(String(cause))
    }
  }

  const addPoint = (event: React.MouseEvent<HTMLImageElement>) => {
    if (!scan) return
    const rect = event.currentTarget.getBoundingClientRect()
    const px = ((event.clientX - rect.left) / rect.width) * scan.width
    const py = ((event.clientY - rect.top) / rect.height) * scan.height
    setGcps((current) => [
      ...current,
      { px, py, lon: center[0], lat: center[1] },
    ])
    setSolution(null)
  }

  const update = (index: number, patch: Partial<Gcp>) => {
    setGcps((current) =>
      current.map((gcp, position) =>
        position === index ? { ...gcp, ...patch } : gcp,
      ),
    )
    setSolution(null)
  }

  const remove = (index: number) => {
    setGcps((current) => current.filter((_, position) => position !== index))
    setSolution(null)
  }

  const fit = async () => {
    if (!scan) return
    setBusy(true)
    setError(null)
    try {
      setSolution(await solveGeoref(gcps, scan.width, scan.height, model))
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const writeCog = async () => {
    if (!scan) return
    setBusy(true)
    setError(null)
    try {
      const target = await save({
        title: tx('Сохранить GeoTIFF', 'Save a GeoTIFF'),
        defaultPath: scan.path.replace(/\.[^.\\/]+$/, '') + '-georef.tif',
        filters: [{ name: 'GeoTIFF', extensions: ['tif', 'tiff'] }],
      })
      if (typeof target !== 'string') return
      const report = await warpScan(scan.path, target, gcps, model)
      showToast(
        tx('Сохранено: {p0} ({p1}×{p2})', 'Saved: {p0} ({p1}×{p2})', {
          p0: target,
          p1: report.width,
          p2: report.height,
        }),
      )
      onClose()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const enough = gcps.length >= (model === 'helmert' ? 2 : 3)
  const good = solution !== null && solution.rmse <= 30

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="georef-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tx('Геореференсинг скана', 'Scan georeferencing')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{tx('Скан', 'Scan')}</span>
            <h2>{tx('Геореференсинг скана', 'Scan georeferencing')}</h2>
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

        {!scan ? (
          <div className="georef-empty">
            <p className="settings-hint">
              {tx(
                'Откройте скан карты, поставьте не меньше трёх опорных точек и сохраните результат в GeoTIFF/COG для QGIS.',
                'Open a map scan, place at least three control points and save a GeoTIFF/COG for QGIS.',
              )}
            </p>
            <button type="button" className="primary-button" onClick={() => void pickScan()}>
              <FileImage size={15} />
              {tx('Открыть скан', 'Open a scan')}
            </button>
          </div>
        ) : (
          <>
            <p className="settings-hint">
              {tx(
                'Наведите карту на объект и щёлкните по нему на скане — точка получит координаты центра карты. Затем поправьте координаты в таблице.',
                'Pan the map to a feature and click it on the scan: the point takes the map centre. Fine-tune the coordinates in the table.',
              )}
            </p>
            <div className="georef-body">
              <img
                className="georef-preview"
                src={scan.url}
                alt={tx('Скан карты', 'Map scan')}
                onClick={addPoint}
              />
              <div className="georef-side">
                <label className="georef-model">
                  <span>{tx('Преобразование', 'Transform')}</span>
                  <select
                    value={model}
                    onChange={(event) => {
                      setModel(event.target.value as GeorefModel)
                      setSolution(null)
                    }}
                  >
                    <option value="affine">
                      {tx('Аффинное (3+ точки)', 'Affine (3+ points)')}
                    </option>
                    <option value="helmert">
                      {tx('Гельмерта (2+ точки)', 'Helmert (2+ points)')}
                    </option>
                  </select>
                </label>
                <div className="georef-actions">
                  <button type="button" className="ghost-button" onClick={() => void pickScan()}>
                    <FileImage size={14} />
                    {tx('Другой скан', 'Other scan')}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={!enough || busy}
                    onClick={() => void fit()}
                  >
                    <Crosshair size={14} />
                    {tx('Рассчитать', 'Fit')}
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!good || busy}
                    onClick={() => void writeCog()}
                  >
                    <Save size={14} />
                    {tx('Сохранить COG', 'Save COG')}
                  </button>
                </div>
                {solution && (
                  <p className={good ? 'georef-ok' : 'georef-warn'}>
                    {tx('RMSE: {p0} м', 'RMSE: {p0} m', {
                      p0: solution.rmse.toFixed(1),
                    })}
                  </p>
                )}
                <ul className="georef-points">
                  {gcps.map((gcp, index) => (
                    <li key={index}>
                      <span className="mono">
                        {gcp.px.toFixed(0)},{gcp.py.toFixed(0)}
                      </span>
                      <input
                        type="number"
                        step="0.000001"
                        value={gcp.lon}
                        aria-label={tx('Долгота', 'Longitude')}
                        onChange={(event) =>
                          update(index, { lon: Number(event.target.value) })
                        }
                      />
                      <input
                        type="number"
                        step="0.000001"
                        value={gcp.lat}
                        aria-label={tx('Широта', 'Latitude')}
                        onChange={(event) =>
                          update(index, { lat: Number(event.target.value) })
                        }
                      />
                      <button
                        type="button"
                        className="georef-remove"
                        onClick={() => remove(index)}
                        aria-label={tx('Удалить точку', 'Remove the point')}
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </>
        )}

        {error && <p className="georef-error">{error}</p>}
      </section>
    </div>
  )
}
