/** Offline route builder and off-route alert settings. */

import { useMemo, useState } from 'react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import {
  Clock3,
  Download,
  Flag,
  Loader2,
  LocateFixed,
  MapPin,
  Route as RouteIcon,
  TriangleAlert,
} from 'lucide-react'
import {
  formatDistance,
  parseCoordinateText,
  type LonLat,
} from './geo.ts'
import { formatDuration } from './format.ts'
import { featureId, type MapFeature } from './features.ts'
import { useGpsStore } from './gps.ts'
import { useText } from './i18n.ts'
import {
  DEFAULT_ROUTE_TOLERANCE,
  RouteError,
  buildIsochrone,
  buildRoute,
  buildSteps,
  distanceToRoute,
  remoteRoute,
  routeCorridor as corridorPolygon,
  routeLines,
  type RoutePlan,
  type RouteStep,
  type RoutingEngine,
} from './routing.ts'
import { useAppStore } from './store.ts'

const routeErrorLabel = (
  error: unknown,
  tx: (ru: string, en: string) => string,
): string => {
  if (!(error instanceof RouteError)) {
    return tx('Не удалось построить маршрут.', 'Could not build the route.')
  }
  switch (error.code) {
    case 'no-lines':
      return tx(
        'Нет линий для маршрута. Включите объекты или импортируйте векторный слой с дорогами.',
        'No routable lines. Enable objects or import a vector layer with roads.',
      )
    case 'too-large':
      return tx(
        'Слишком большой граф. Отключите лишние слои или уменьшите район.',
        'The graph is too large. Disable extra layers or reduce the area.',
      )
    case 'start-snap':
      return tx(
        'Старт дальше 250 м от сети линий. Поставьте точку ближе к дороге.',
        'The start is more than 250 m from the line network. Move it closer to a road.',
      )
    case 'end-snap':
      return tx(
        'Финиш дальше 250 м от сети линий. Поставьте точку ближе к дороге.',
        'The finish is more than 250 m from the line network. Move it closer to a road.',
      )
    case 'no-path':
      return tx(
        'Между точками нет связного пути. Проверьте стыки линий и допуск.',
        'No connected path exists. Check line junctions and the snap tolerance.',
      )
  }
}

const offlineSpeed = (profile: string): number => {
  switch (profile) {
    case 'walking':
      return 5
    case 'cycling':
      return 15
    default:
      return 50
  }
}

const profileOptions = (
  engine: RoutingEngine,
): { value: string; ru: string; en: string }[] => {
  if (engine === 'osrm') {
    return [
      { value: 'driving', ru: 'Автомобиль', en: 'Car' },
      { value: 'bike', ru: 'Велосипед', en: 'Bike' },
      { value: 'foot', ru: 'Пешком', en: 'Foot' },
    ]
  }
  if (engine === 'brouter') {
    return [
      { value: 'car-eco', ru: 'Автомобиль', en: 'Car' },
      { value: 'trekking', ru: 'Треккинг', en: 'Trekking' },
      { value: 'fastbike', ru: 'Велосипед', en: 'Bike' },
      { value: 'shortest', ru: 'Кратчайший', en: 'Shortest' },
    ]
  }
  return [
    { value: 'driving', ru: 'Автомобиль', en: 'Car' },
    { value: 'walking', ru: 'Пешком', en: 'Walking' },
    { value: 'cycling', ru: 'Велосипед', en: 'Cycling' },
  ]
}

const maneuverText = (
  step: RouteStep,
  tx: (ru: string, en: string) => string,
): string => {
  const label = (() => {
    if (step.maneuver === 'depart') return tx('Старт', 'Start')
    if (step.maneuver === 'arrive') return tx('Финиш', 'Finish')
    if (step.maneuver === 'roundabout' || step.maneuver === 'rotary') {
      return tx('Круговое движение', 'Roundabout')
    }
    if (step.maneuver === 'uturn' || step.modifier === 'uturn') {
      return tx('Разворот', 'U-turn')
    }
    if (step.modifier.includes('sharp')) {
      return step.modifier.includes('left')
        ? tx('Резко налево', 'Sharp left')
        : tx('Резко направо', 'Sharp right')
    }
    if (step.modifier.includes('slight')) {
      return step.modifier.includes('left')
        ? tx('Плавно налево', 'Slight left')
        : tx('Плавно направо', 'Slight right')
    }
    if (step.modifier.includes('left')) return tx('Налево', 'Left')
    if (step.modifier.includes('right')) return tx('Направо', 'Right')
    return tx('Прямо', 'Straight')
  })()
  return step.name ? `${label} · ${step.name}` : label
}

const coordinateText = (point: LonLat): string =>
  `${point[1].toFixed(6)}, ${point[0].toFixed(6)}`

export function RoutePanel({ map }: { map: MapLibreMap | null }) {
  const tx = useText()
  const features = useAppStore((state) => state.features)
  const vectorLayers = useAppStore((state) => state.vectorLayers)
  const addFeatures = useAppStore((state) => state.addFeatures)
  const selectFeature = useAppStore((state) => state.selectFeature)
  const showToast = useAppStore((state) => state.showToast)
  const routeFeatureId = useAppStore((state) => state.routeFeatureId)
  const setRouteFeatureId = useAppStore(
    (state) => state.setRouteFeatureId,
  )
  const routeCorridor = useAppStore((state) => state.routeCorridor)
  const setRouteCorridor = useAppStore((state) => state.setRouteCorridor)
  const routeAlert = useAppStore((state) => state.routeAlert)
  const setRouteAlert = useAppStore((state) => state.setRouteAlert)
  const routingEngine = useAppStore((state) => state.routingEngine)
  const setRoutingEngine = useAppStore((state) => state.setRoutingEngine)
  const routingUrl = useAppStore((state) => state.routingUrl)
  const routingProfile = useAppStore((state) => state.routingProfile)
  const setRoutingProfile = useAppStore((state) => state.setRoutingProfile)
  const setSelection = useAppStore((state) => state.setSelection)
  const setSelectionPolygon = useAppStore(
    (state) => state.setSelectionPolygon,
  )
  const setDownloadOpen = useAppStore((state) => state.setDownloadOpen)
  const fix = useGpsStore((state) => state.fix)

  const [startText, setStartText] = useState('')
  const [endText, setEndText] = useState('')
  const [useFeatures, setUseFeatures] = useState(true)
  const [useVectors, setUseVectors] = useState(true)
  const [tolerance, setTolerance] = useState(DEFAULT_ROUTE_TOLERANCE)
  const [result, setResult] = useState<RoutePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  const [isochroneMinutes, setIsochroneMinutes] = useState(15)
  const [isochroneStats, setIsochroneStats] = useState<string | null>(null)

  const lineFeatures = useMemo(
    () =>
      features.filter(
        (feature) => feature.kind === 'line' && feature.coordinates.length >= 2,
      ),
    [features],
  )
  const route = lineFeatures.find((feature) => feature.id === routeFeatureId)
  const deviation =
    route && fix
      ? distanceToRoute([fix.lon, fix.lat], route.coordinates)
      : null
  const offRoute = deviation !== null && deviation > routeCorridor

  const setPoint = (which: 'start' | 'end', point: LonLat) => {
    const text = coordinateText(point)
    if (which === 'start') setStartText(text)
    else setEndText(text)
  }

  const fromCenter = (which: 'start' | 'end') => {
    if (!map) return
    const center = map.getCenter()
    setPoint(which, [center.lng, center.lat])
  }

  const fromGps = () => {
    if (!fix) return
    setPoint('start', [fix.lon, fix.lat])
  }

  const addRoute = (plan: RoutePlan) => {
    const time = new Date().toLocaleTimeString(
      useAppStore.getState().locale === 'ru'
        ? 'ru-RU'
        : useAppStore.getState().locale,
      { hour: '2-digit', minute: '2-digit' },
    )
    const feature: MapFeature = {
      id: featureId(),
      name: tx('Маршрут {time}', 'Route {time}', { time }),
      kind: 'line',
      coordinates: plan.coordinates,
      color: '#4cc9f0',
    }
    addFeatures([feature])
    selectFeature(feature.id)
    setRouteFeatureId(feature.id)
    setResult(plan)
    showToast(
      tx(
        'Маршрут: {distance} · {duration}',
        'Route: {distance} · {duration}',
        {
          distance: formatDistance(plan.distance),
          duration: formatDuration(plan.duration),
        },
      ),
    )
  }

  const build = async () => {
    setError(null)
    setResult(null)
    const start = parseCoordinateText(startText)
    const end = parseCoordinateText(endText)
    if (!start || !end) {
      setError(
        tx(
          'Укажите старт и финиш в формате «широта, долгота», DMS или UTM.',
          'Enter start and finish as “latitude, longitude”, DMS or UTM.',
        ),
      )
      return
    }
    setBuilding(true)
    try {
      if (routingEngine !== 'offline') {
        const plan = await remoteRoute(
          routingEngine,
          routingUrl,
          routingProfile,
          start.point,
          end.point,
        )
        addRoute(plan)
        return
      }
      const lines = routeLines({
        features,
        vectorLayers,
        useFeatures,
        useVectors,
      })
      const built = buildRoute(lines, start.point, end.point, tolerance)
      if (built.coordinates.length < 2) {
        setError(
          tx(
            'Старт и финиш попали в одну точку сети.',
            'Start and finish snap to the same network point.',
          ),
        )
        return
      }
      const speed = offlineSpeed(routingProfile)
      const duration = built.distance / ((speed * 1000) / 3600)
      addRoute({
        ...built,
        duration,
        steps: buildSteps(built.coordinates, built.distance, duration),
        engine: 'offline',
      })
    } catch (caught) {
      setError(
        caught instanceof RouteError
          ? routeErrorLabel(caught, tx)
          : `${tx('Сервер маршрутов:', 'Routing server:')} ${String(caught)}`,
      )
    } finally {
      setBuilding(false)
    }
  }

  const downloadCorridor = () => {
    if (!result || result.coordinates.length < 2) return
    const polygon = corridorPolygon(result.coordinates, 250)
    if (polygon.length < 3) return
    setSelection(null)
    setSelectionPolygon(polygon)
    setDownloadOpen(true)
  }

  const buildIsochroneHere = () => {
    try {
      const lines = routeLines({
        features,
        vectorLayers,
        useFeatures,
        useVectors,
      })
      const start = parseCoordinateText(startText)
      if (!start) {
        setError(
          tx(
            'Укажите старт в формате «широта, долгота», DMS или UTM.',
            'Enter start as “latitude, longitude”, DMS or UTM.',
          ),
        )
        return
      }
      const iso = buildIsochrone(
        lines,
        start.point,
        isochroneMinutes,
        offlineSpeed(routingProfile),
        tolerance,
      )
      const feature: MapFeature = {
        id: featureId(),
        name: tx(
          'Изохрона {minutes} мин',
          'Isochrone {minutes} min',
          { minutes: isochroneMinutes },
        ),
        kind: 'polygon',
        coordinates: iso.coordinates,
        color: '#22c55e',
      }
      addFeatures([feature])
      selectFeature(feature.id)
      setIsochroneStats(
        tx(
          'Доступно {distance} м по сети · {nodes} узлов',
          '{distance} m reachable · {nodes} nodes',
          {
            distance: Math.round(iso.distance),
            nodes: iso.reachableNodes,
          },
        ),
      )
    } catch (caught) {
      setError(routeErrorLabel(caught, tx))
    }
  }

  return (
    <div className="inspector-body">
      <section className="card">
        <div className="card-heading">
          <span className="card-icon">
            <RouteIcon size={15} />
          </span>
          <div>
            <span className="eyebrow">
              {tx('Маршрутизация', 'Routing')}
            </span>
            <strong>{tx('Построение маршрута', 'Route planning')}</strong>
          </div>
        </div>

        <div className="settings-field">
          <span>{tx('Движок', 'Engine')}</span>
          <select
            className="settings-input"
            value={routingEngine}
            onChange={(event) => {
              const engine = event.target.value as RoutingEngine
              setRoutingEngine(engine)
              setRoutingProfile(profileOptions(engine)[0].value)
            }}
            aria-label={tx('Движок маршрутизации', 'Routing engine')}
          >
            <option value="offline">
              {tx('Офлайн по линиям', 'Offline lines')}
            </option>
            <option value="osrm">OSRM</option>
            <option value="brouter">BRouter</option>
          </select>
        </div>

        <div className="settings-field">
          <span>{tx('Профиль', 'Profile')}</span>
          <select
            className="settings-input"
            value={routingProfile}
            onChange={(event) => setRoutingProfile(event.target.value)}
            aria-label={tx('Профиль маршрута', 'Routing profile')}
          >
            {profileOptions(routingEngine).map((option) => (
              <option key={option.value} value={option.value}>
                {tx(option.ru, option.en)}
              </option>
            ))}
          </select>
        </div>

        {routingEngine !== 'offline' && (
          <p className="settings-hint">
            {routingUrl
              ? tx('Сервер: {url}', 'Server: {url}', { url: routingUrl })
              : tx(
                  'Публичный сервер. Свой адрес задаётся в настройках.',
                  'Public server. Set a custom URL in settings.',
                )}
          </p>
        )}

        <div className="settings-field route-point">
          <span>
            <MapPin size={12} /> {tx('Старт', 'Start')}
          </span>
          <input
            className="settings-input"
            value={startText}
            placeholder={tx('55.7558, 37.6173', '55.7558, 37.6173')}
            onChange={(event) => setStartText(event.target.value)}
            aria-label={tx('Координаты старта', 'Start coordinates')}
          />
        </div>
        <div className="route-point-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={fromGps}
            disabled={!fix}
          >
            <LocateFixed size={12} />
            {tx('Из GPS', 'From GPS')}
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => fromCenter('start')}
            disabled={!map}
          >
            {tx('Из центра', 'From centre')}
          </button>
        </div>

        <div className="settings-field route-point">
          <span>
            <Flag size={12} /> {tx('Финиш', 'Finish')}
          </span>
          <input
            className="settings-input"
            value={endText}
            placeholder={tx('55.7600, 37.6300', '55.7600, 37.6300')}
            onChange={(event) => setEndText(event.target.value)}
            aria-label={tx('Координаты финиша', 'Finish coordinates')}
          />
        </div>
        <div className="route-point-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => fromCenter('end')}
            disabled={!map}
          >
            {tx('Из центра', 'From centre')}
          </button>
        </div>

        <label className="source-check">
          <input
            type="checkbox"
            checked={useFeatures}
            onChange={(event) => setUseFeatures(event.target.checked)}
          />
          {tx('Использовать линии объектов', 'Use object lines')}
        </label>
        <label className="source-check">
          <input
            type="checkbox"
            checked={useVectors}
            onChange={(event) => setUseVectors(event.target.checked)}
          />
          {tx(
            'Использовать векторные слои',
            'Use vector layers',
          )}
        </label>

        <div className="settings-field">
          <span>{tx('Допуск стыков', 'Snap tolerance')}</span>
          <input
            type="range"
            min="1"
            max="50"
            step="1"
            value={tolerance}
            onChange={(event) => setTolerance(Number(event.target.value))}
            aria-label={tx('Допуск стыков, метры', 'Snap tolerance, metres')}
          />
          <span className="mono">{tolerance} m</span>
        </div>

        <button
          type="button"
          className="primary-button"
          onClick={() => void build()}
          disabled={
            building ||
            (routingEngine === 'offline' && !useFeatures && !useVectors)
          }
        >
          {building ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <RouteIcon size={14} />
          )}
          {tx('Построить маршрут', 'Build route')}
        </button>

        {error && (
          <p className="gps-error" role="alert">
            {error}
          </p>
        )}
        {result && (
          <div className="route-result">
            <div className="gps-metrics">
              <div>
                <span>{tx('Длина', 'Length')}</span>
                <strong>{formatDistance(result.distance)}</strong>
              </div>
              <div>
                <span>{tx('Время', 'Time')}</span>
                <strong>{formatDuration(result.duration)}</strong>
              </div>
              <div>
                <span>{tx('Точек', 'Points')}</span>
                <strong>{result.coordinates.length}</strong>
              </div>
              <div>
                <span>{tx('Сеть', 'Network')}</span>
                <strong>
                  {result.engine === 'offline'
                    ? `${result.stats.nodes}/${result.stats.edges}`
                    : result.engine.toUpperCase()}
                </strong>
              </div>
            </div>
            <p className="settings-hint">
              {result.engine === 'offline'
                ? tx(
                    'Старт привязан на {p0} м, финиш — на {p1} м.',
                    'Start snapped {p0} m away, finish {p1} m.',
                    { p0: Math.round(result.startOffset), p1: Math.round(result.endOffset) },
                  )
                : tx(
                    'Маршрут получен с внешнего сервера.',
                    'Route received from the remote server.',
                  )}
            </p>

            {result.steps.length > 0 && (
              <ol className="route-steps">
                {result.steps.map((step, index) => (
                  <li key={`${index}-${step.distance}`}>
                    <span>{maneuverText(step, tx)}</span>
                    <small>
                      {formatDistance(step.distance)}
                      {step.duration > 0 ? ` · ${formatDuration(step.duration)}` : ''}
                    </small>
                  </li>
                ))}
              </ol>
            )}

            <button
              type="button"
              className="secondary-button full-width"
              onClick={downloadCorridor}
            >
              <Download size={14} />
              {tx('Скачать коридор 500 м', 'Download 500 m corridor')}
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-heading">
          <span className="card-icon">
            <Clock3 size={15} />
          </span>
          <div>
            <span className="eyebrow">
              {tx('Доступность', 'Reachability')}
            </span>
            <strong>{tx('Изохрона', 'Isochrone')}</strong>
          </div>
        </div>

        <div className="settings-field">
          <span>{tx('Время в пути', 'Travel time')}</span>
          <input
            type="range"
            min="5"
            max="120"
            step="5"
            value={isochroneMinutes}
            onChange={(event) =>
              setIsochroneMinutes(Number(event.target.value))
            }
            aria-label={tx('Время изохроны, минуты', 'Isochrone time, minutes')}
          />
          <span className="mono">{isochroneMinutes} min</span>
        </div>

        <button
          type="button"
          className="secondary-button full-width"
          onClick={buildIsochroneHere}
          disabled={
            !useFeatures && !useVectors
              ? true
              : false
          }
        >
          <Clock3 size={14} />
          {tx('Построить изохрону', 'Build isochrone')}
        </button>

        {isochroneStats && (
          <p className="settings-hint">{isochroneStats}</p>
        )}
        <p className="settings-hint">
          {tx(
            'Скорость профиля: {speed} км/ч. Изохрона строится по загруженным линиям и сохраняется как полигон.',
            'Profile speed: {speed} km/h. The isochrone follows loaded lines and is saved as a polygon.',
            { speed: offlineSpeed(routingProfile) },
          )}
        </p>
      </section>

      <section className="card">
        <div className="card-heading">
          <span className="card-icon">
            <TriangleAlert size={15} />
          </span>
          <div>
            <span className="eyebrow">
              {tx('Полевой контроль', 'Field control')}
            </span>
            <strong>{tx('Отклонение от маршрута', 'Off-route alert')}</strong>
          </div>
        </div>

        <div className="settings-field">
          <span>{tx('Маршрут', 'Route')}</span>
          <select
            className="settings-input"
            value={routeFeatureId ?? ''}
            onChange={(event) =>
              setRouteFeatureId(event.target.value || null)
            }
          >
            <option value="">{tx('Не выбран', 'Not selected')}</option>
            {lineFeatures.map((feature) => (
              <option key={feature.id} value={feature.id}>
                {feature.name}
              </option>
            ))}
          </select>
        </div>

        <label className="source-check">
          <input
            type="checkbox"
            checked={routeAlert}
            onChange={(event) => setRouteAlert(event.target.checked)}
          />
          {tx(
            'Предупреждать при отклонении',
            'Warn when off route',
          )}
        </label>

        <div className="settings-field">
          <span>{tx('Коридор', 'Corridor')}</span>
          <input
            type="range"
            min="5"
            max="500"
            step="5"
            value={routeCorridor}
            onChange={(event) =>
              setRouteCorridor(Number(event.target.value))
            }
            disabled={!routeAlert}
            aria-label={tx('Ширина коридора, метры', 'Corridor width, metres')}
          />
          <span className="mono">{routeCorridor} m</span>
        </div>

        {routeAlert && !fix && (
          <p className="settings-hint">
            {tx(
              'Включите GPS или NMEA, чтобы видеть отклонение.',
              'Enable GPS or NMEA to see the deviation.',
            )}
          </p>
        )}
        {routeAlert && route && deviation !== null && (
          <div className={`route-status${offRoute ? ' is-off' : ''}`}>
            <span>
              {offRoute
                ? tx('Отклонение', 'Off route')
                : tx('На маршруте', 'On route')}
            </span>
            <strong>{formatDistance(deviation)}</strong>
          </div>
        )}
        {routeAlert && !route && (
          <p className="settings-hint">
            {tx(
              'Выберите линию или постройте маршрут.',
              'Select a line or build a route.',
            )}
          </p>
        )}
      </section>
    </div>
  )
}
