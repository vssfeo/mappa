import { useEffect, useRef, useState } from 'react'
import { useT, useText } from './i18n'
import { providerById } from './providers'
import { demSample, type DemSample } from './dem'
import { useGpsStore } from './gps.ts'
import { distanceToRoute } from './routing.ts'
import { useAppStore } from './store'
import { useViewStore } from './viewStore'
import { formatBytes, formatCount } from './format'
import { formatCoordinatePair, formatDistance } from './geo'
import {
  cacheStats,
  isNative,
  transformPoints,
  type NativeCacheStats,
} from './native'

export function StatusBar() {
  const t = useT()
  const tx = useText()
  const mapView = useViewStore((state) => state.mapView)
  const cursor = useViewStore((state) => state.cursor)
  const providerId = useAppStore((state) => state.providerId)
  const coordinateFormat = useAppStore((state) => state.coordinateFormat)
  const crs = useAppStore((state) => state.crs)
  const crsLabel = useAppStore((state) => state.crsLabel)
  const dem = useAppStore((state) => state.dem)
  const showToast = useAppStore((state) => state.showToast)
  const features = useAppStore((state) => state.features)
  const routeFeatureId = useAppStore((state) => state.routeFeatureId)
  const routeCorridor = useAppStore((state) => state.routeCorridor)
  const routeAlert = useAppStore((state) => state.routeAlert)
  const fix = useGpsStore((state) => state.fix)
  const wasOffRoute = useRef(false)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [cache, setCache] = useState<NativeCacheStats | null>(null)
  const [projected, setProjected] = useState<{
    key: string
    point: [number, number]
  } | null>(null)
  const [terrain, setTerrain] = useState<{
    id: string
    sample: DemSample | null
  } | null>(null)

  useEffect(() => {
    if (!isNative) return
    let alive = true
    const load = () => {
      void cacheStats().then((stats) => {
        if (alive) setCache(stats)
      })
    }
    load()
    const timer = window.setInterval(load, 4000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const provider = providerById(providerId)
  const [lon, lat] = cursor ?? mapView.center

  const crsKey = crs
    ? crs.epsg
      ? `EPSG:${crs.epsg}`
      : `PROJ:${crs.proj ?? ''}`
    : ''

  useEffect(() => {
    if (!crs || !isNative) return
    let alive = true
    const timer = window.setTimeout(() => {
      void transformPoints({ epsg: 4326 }, crs, [[lon, lat]])
        .then((points) => {
          if (alive && points[0]) {
            setProjected({ key: crsKey, point: points[0] })
          }
        })
        .catch(() => {
          // Keep the WGS84 readout; the error is surfaced by the map toast.
        })
    }, 60)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [crs, crsKey, lon, lat])

  useEffect(() => {
    if (!dem || !isNative) return
    let alive = true
    const timer = window.setTimeout(() => {
      void demSample(lon, lat)
        .then((sample) => {
          if (alive) setTerrain({ id: dem.id, sample })
        })
        .catch(() => {
          // Terrain is supplementary; coordinate readout stays usable.
        })
    }, 180)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [dem, lon, lat])

  const terrainSample =
    terrain && terrain.id === dem?.id ? terrain.sample : null
  const current = projected?.key === crsKey ? projected.point : null
  const geographicOutput =
    current !== null &&
    Math.abs(current[0]) <= 180 &&
    Math.abs(current[1]) <= 90
  const coordinates =
    crs && current
      ? `${current[0].toFixed(geographicOutput ? 7 : 2)}, ${current[1].toFixed(geographicOutput ? 7 : 2)}`
      : formatCoordinatePair(lon, lat, coordinateFormat)

  const route = routeFeatureId
    ? features.find(
        (feature) =>
          feature.id === routeFeatureId &&
          feature.kind === 'line' &&
          feature.coordinates.length >= 2,
      )
    : undefined
  const deviation =
    route && fix
      ? distanceToRoute([fix.lon, fix.lat], route.coordinates)
      : null
  const offRoute =
    routeAlert && deviation !== null && deviation > routeCorridor

  useEffect(() => {
    if (!routeAlert || deviation === null) {
      wasOffRoute.current = false
      return
    }
    const off = deviation > routeCorridor
    if (off && !wasOffRoute.current) {
      showToast(
        tx(
          'Отклонение от маршрута: {p0}',
          'Off route: {p0}',
          { p0: formatDistance(deviation) },
        ),
      )
    } else if (!off && wasOffRoute.current) {
      showToast(tx('Вернулись на маршрут', 'Back on route'))
    }
    wasOffRoute.current = off
  }, [deviation, routeAlert, routeCorridor, showToast, tx])

  const copyCoordinates = async () => {
    try {
      await navigator.clipboard.writeText(coordinates)
      showToast(t('status.copied'))
    } catch {
      showToast(tx(
                  'Координаты: {p0}',
                  'Coordinates: {p0}',
                  { p0: coordinates },
                ))
    }
  }

  return (
    <footer className="statusbar">
      <div className="status-left">
        <span className="status-chip">z{mapView.zoom.toFixed(1)}</span>
        <span>
          {mapView.scale > 0
            ? `1:${formatCount(Math.round(mapView.scale))}`
            : '—'}
        </span>
        <button
          type="button"
          className="status-coords"
          onClick={copyCoordinates}
          title={`${t('status.copyTitle')} · ${
            crs && current ? crsLabel || 'CRS' : coordinateFormat.toUpperCase()
          }`}
        >
          {coordinates}
        </button>
        {terrainSample && (
          <span
            className="status-muted"
            title={tx(
                     'Высота {p0} м · уклон {p1}° · экспозиция {p2}°',
                     'Elevation {p0} m · slope {p1}° · aspect {p2}°',
                     { p0: Math.round(terrainSample.elevation), p1: terrainSample.slope.toFixed(1), p2: Math.round(terrainSample.aspect) },
                   )}
          >
            ▲ {formatCount(Math.round(terrainSample.elevation))} м
          </span>
        )}
        {routeAlert && deviation !== null && (
          <span
            className={`status-route${offRoute ? ' is-off' : ''}`}
            title={
              route?.name
                ? tx(
                    'Отклонение от «{p0}»: {p1}',
                    'Deviation from “{p0}”: {p1}',
                    { p0: route.name, p1: formatDistance(deviation) },
                  )
                : tx(
                    'Отклонение от маршрута: {p0}',
                    'Deviation from route: {p0}',
                    { p0: formatDistance(deviation) },
                  )
            }
          >
            <span className="status-route-dot" />
            {offRoute
              ? tx('отклонение', 'off route')
              : tx('на маршруте', 'on route')}{' '}
            {formatDistance(deviation)}
          </span>
        )}
      </div>
      <div className="status-center">
        <a href={provider.terms} target="_blank" rel="noreferrer">
          {provider.attribution}
        </a>
      </div>
      <div className="status-right">
        <span
          className="status-muted"
          title={
            cache
              ? `${t('status.hits')}: ${formatCount(cache.hits)} · ${t('status.misses')}: ${formatCount(cache.misses)}`
              : undefined
          }
        >
          {cache
            ? `${t('status.cache')}: ${formatCount(cache.tiles)} · ${formatBytes(cache.bytes)}`
            : `${t('status.cache')}: —`}
        </span>
        <span className={`network-state${online ? '' : ' is-offline'}`}>
          <span className="network-dot" />
          {online ? 'online' : 'offline'}
        </span>
        <span className="status-muted">
          {crs && current
            ? crsLabel || 'CRS'
            : `WGS84 · ${coordinateFormat.toUpperCase()}`}
        </span>
      </div>
    </footer>
  )
}
