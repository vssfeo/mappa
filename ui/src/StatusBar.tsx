import { useEffect, useState } from 'react'
import { useT, useText } from './i18n'
import { providerById } from './providers'
import { useAppStore } from './store'
import { useViewStore } from './viewStore'
import { formatBytes, formatCount } from './format'
import { formatCoordinatePair } from './geo'
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
  const showToast = useAppStore((state) => state.showToast)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [cache, setCache] = useState<NativeCacheStats | null>(null)
  const [projected, setProjected] = useState<{
    key: string
    point: [number, number]
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
  const [lat, lon] = cursor ?? mapView.center

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

  const current = projected?.key === crsKey ? projected.point : null
  const geographicOutput =
    current !== null &&
    Math.abs(current[0]) <= 180 &&
    Math.abs(current[1]) <= 90
  const coordinates =
    crs && current
      ? `${current[0].toFixed(geographicOutput ? 7 : 2)}, ${current[1].toFixed(geographicOutput ? 7 : 2)}`
      : formatCoordinatePair(lon, lat, coordinateFormat)

  const copyCoordinates = async () => {
    try {
      await navigator.clipboard.writeText(coordinates)
      showToast(t('status.copied'))
    } catch {
      showToast(tx(`Координаты: ${coordinates}`, `Coordinates: ${coordinates}`))
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
