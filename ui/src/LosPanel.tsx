import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Eye, Radio, X } from 'lucide-react'
import { useText } from './i18n'
import { useAppStore } from './store'
import { useViewStore } from './viewStore'
import { featureId } from './features'
import { computeLos, computeViewshed, type LosReport } from './viewshed'
import { useDialogFocus } from './useDialogFocus'

interface LosPanelProps {
  onClose: () => void
}

const WIDTH = 660
const HEIGHT = 230

/** Terrain profile, Fresnel zone and viewshed around the observer. */
export function LosPanel({ onClose }: LosPanelProps) {
  const tx = useText()
  const center = useViewStore((state) => state.mapView.center)
  const addFeatures = useAppStore((state) => state.addFeatures)
  const showToast = useAppStore((state) => state.showToast)
  const dialogRef = useRef<HTMLElement | null>(null)
  useDialogFocus(dialogRef, onClose)

  const [from, setFrom] = useState<[number, number]>([center[0], center[1]])
  const [to, setTo] = useState<[number, number]>([
    center[0] + 0.02,
    center[1] + 0.01,
  ])
  const [observerHeight, setObserverHeight] = useState(10)
  const [targetHeight, setTargetHeight] = useState(10)
  const [frequency, setFrequency] = useState(5.8)
  const [radiusKm, setRadiusKm] = useState(5)
  const [report, setReport] = useState<LosReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const chart = useMemo(() => {
    if (!report || report.points.length < 2) return null
    const total = report.distanceM || 1
    const heights = report.points.flatMap((point) => [
      point.terrainM,
      point.losM + point.fresnelM,
      point.losM - point.fresnelM,
    ])
    const min = Math.min(...heights)
    const max = Math.max(...heights)
    const span = Math.max(1, max - min)
    const x = (distance: number) => (distance / total) * WIDTH
    const y = (height: number) => HEIGHT - ((height - min) / span) * (HEIGHT - 16) - 8
    const terrain = report.points
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.distanceM).toFixed(1)},${y(point.terrainM).toFixed(1)}`)
      .join(' ')
    const losLine = report.points
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.distanceM).toFixed(1)},${y(point.losM).toFixed(1)}`)
      .join(' ')
    const fresnelTop = report.points
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.distanceM).toFixed(1)},${y(point.losM + point.fresnelM).toFixed(1)}`)
      .join(' ')
    const fresnelBottom = [...report.points]
      .reverse()
      .map((point) => `L${x(point.distanceM).toFixed(1)},${y(point.losM - point.fresnelM).toFixed(1)}`)
      .join(' ')
    return { terrain, losLine, fresnel: `${fresnelTop} ${fresnelBottom} Z`, min, max }
  }, [report])

  const runProfile = async () => {
    setBusy(true)
    setError(null)
    try {
      setReport(
        await computeLos(from, to, observerHeight, targetHeight, frequency),
      )
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const runViewshed = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await computeViewshed(
        from,
        Math.round(radiusKm * 1000),
        observerHeight,
      )
      addFeatures([
        {
          id: featureId(),
          name: tx('Зона видимости', 'Viewshed'),
          kind: 'polygon',
          coordinates: result.polygon,
          color: '#43d9c5',
          description: tx('Площадь: {p0} км²', 'Area: {p0} km²', {
            p0: result.areaKm2.toFixed(1),
          }),
        },
      ])
      showToast(
        tx('Зона видимости: {p0} км²', 'Viewshed: {p0} km²', {
          p0: result.areaKm2.toFixed(1),
        }),
      )
      onClose()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const addLink = () => {
    addFeatures([
      {
        id: featureId(),
        name: tx('Радиолинк', 'Radio link'),
        kind: 'line',
        coordinates: [from, to],
        color: '#ff7a45',
      },
    ])
    onClose()
  }

  const updateEnd = (
    setter: Dispatch<SetStateAction<[number, number]>>,
    index: 0 | 1,
    value: number,
  ) => {
    setter((current) => {
      const next: [number, number] = [current[0], current[1]]
      next[index] = value
      return next
    })
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="los-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tx('Радиолинк и зона видимости', 'Radio link and viewshed')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{tx('Рельеф', 'Terrain')}</span>
            <h2>{tx('Радиолинк и зона видимости', 'Radio link and viewshed')}</h2>
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
            <span>{tx('Точка А, долгота', 'Point A, longitude')}</span>
            <input
              type="number"
              step="0.0001"
              value={from[0]}
              onChange={(event) => updateEnd(setFrom, 0, Number(event.target.value))}
            />
          </label>
          <label>
            <span>{tx('широта', 'latitude')}</span>
            <input
              type="number"
              step="0.0001"
              value={from[1]}
              onChange={(event) => updateEnd(setFrom, 1, Number(event.target.value))}
            />
          </label>
          <label>
            <span>{tx('Точка Б, долгота', 'Point B, longitude')}</span>
            <input
              type="number"
              step="0.0001"
              value={to[0]}
              onChange={(event) => updateEnd(setTo, 0, Number(event.target.value))}
            />
          </label>
          <label>
            <span>{tx('широта', 'latitude')}</span>
            <input
              type="number"
              step="0.0001"
              value={to[1]}
              onChange={(event) => updateEnd(setTo, 1, Number(event.target.value))}
            />
          </label>
          <label>
            <span>{tx('Высота А, м', 'Height A, m')}</span>
            <input
              type="number"
              min={0}
              max={1000}
              value={observerHeight}
              onChange={(event) => setObserverHeight(Number(event.target.value))}
            />
          </label>
          <label>
            <span>{tx('Высота Б, м', 'Height B, m')}</span>
            <input
              type="number"
              min={0}
              max={1000}
              value={targetHeight}
              onChange={(event) => setTargetHeight(Number(event.target.value))}
            />
          </label>
          <label>
            <span>{tx('Частота, ГГц', 'Frequency, GHz')}</span>
            <input
              type="number"
              min={0.1}
              max={100}
              step="0.1"
              value={frequency}
              onChange={(event) => setFrequency(Number(event.target.value))}
            />
          </label>
          <label>
            <span>{tx('Радиус зоны, км', 'Viewshed radius, km')}</span>
            <input
              type="number"
              min={0.1}
              max={100}
              step="0.5"
              value={radiusKm}
              onChange={(event) => setRadiusKm(Number(event.target.value))}
            />
          </label>
        </div>

        <div className="los-actions">
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void runProfile()}
          >
            <Radio size={15} />
            {tx('Профиль', 'Profile')}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void runViewshed()}
          >
            <Eye size={15} />
            {tx('Зона видимости', 'Viewshed')}
          </button>
          <button type="button" className="ghost-button" onClick={addLink}>
            {tx('Линия на карту', 'Line on the map')}
          </button>
        </div>

        {error && <p className="georef-error">{error}</p>}

        {report && chart && (
          <>
            <svg
              className="los-chart"
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              role="img"
              aria-label={tx('Профиль радиолинка', 'Radio link profile')}
            >
              <path d={`${chart.terrain} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`} className="los-terrain" />
              <path d={chart.fresnel} className="los-fresnel" />
              <path d={chart.losLine} className="los-line" />
              <path d={chart.terrain} className="los-ground" />
            </svg>
            <p className={report.blocked ? 'georef-warn' : 'georef-ok'}>
              {report.blocked
                ? tx('Линк перекрыт рельефом', 'The link is blocked by terrain')
                : tx('Прямая видимость есть', 'Line of sight is clear')}
              {' · '}
              {tx('дистанция {p0} км', 'distance {p0} km', {
                p0: (report.distanceM / 1000).toFixed(2),
              })}
              {' · '}
              {tx('мин. зазор {p0} м', 'min clearance {p0} m', {
                p0: report.minClearanceM.toFixed(1),
              })}
              {' · '}
              {tx('зона Френеля {p0}%', 'Fresnel zone {p0}%', {
                p0: (report.fresnelFraction * 100).toFixed(0),
              })}
            </p>
          </>
        )}

        <p className="settings-hint">
          {tx(
            'Нужен открытый DEM. Расчёт учитывает кривизну Земли с k = 4/3. Зона видимости — приближённая: 720 лучей по рельефу.',
            'An open DEM is required. The model uses earth curvature with k = 4/3. The viewshed is approximate: 720 rays over the terrain.',
          )}
        </p>
      </section>
    </div>
  )
}
