/** Swipe comparison of the active basemap with a second provider. */

import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Columns2, GripVertical, X } from 'lucide-react'
import { Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl'
import { useText } from './i18n'
import { providerTiles } from './native'
import {
  PROVIDERS,
  providerById,
  type ProviderId,
} from './providers'

interface CompareMapProps {
  map: MapLibreMap | null
  activeProviderId: ProviderId
  onClose: () => void
}

const clampSplit = (value: number) => Math.min(0.9, Math.max(0.1, value))

export function CompareMap({
  map,
  activeProviderId,
  onClose,
}: CompareMapProps) {
  const tx = useText()
  const [rightId, setRightId] = useState<ProviderId>(() => {
    const index = PROVIDERS.findIndex((item) => item.id === activeProviderId)
    return PROVIDERS[(index + 1) % PROVIDERS.length].id
  })
  const [split, setSplit] = useState(0.5)
  const overlayRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const compareRef = useRef<MapLibreMap | null>(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    const container = containerRef.current
    if (!map || !container) return
    const provider = providerById(rightId)
    const style: StyleSpecification = {
      version: 8,
      sources: {
        compare: {
          type: 'raster',
          tiles: providerTiles(provider.id, provider.tiles),
          tileSize: provider.tileSize,
          maxzoom: provider.maxZoom,
          attribution: provider.attribution,
        },
      },
      layers: [
        {
          id: 'compare-raster',
          type: 'raster',
          source: 'compare',
          paint: { 'raster-fade-duration': 0 },
        },
      ],
    }
    const compare = new MapLibreMap({
      container,
      style,
      interactive: false,
      attributionControl: false,
    })
    compareRef.current = compare
    // The main map reports tile failures; the compare pane stays quiet.
    compare.on('error', () => {})

    let frame = 0
    const sync = () => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const instance = compareRef.current
        if (!instance) return
        instance.jumpTo({
          center: map.getCenter(),
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch(),
        })
      })
    }
    sync()
    map.on('move', sync)
    map.on('resize', sync)

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      map.off('move', sync)
      map.off('resize', sync)
      compareRef.current = null
      compare.remove()
    }
  }, [map, rightId])

  const updateSplit = (clientX: number) => {
    const rect = overlayRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    setSplit(clampSplit((clientX - rect.left) / rect.width))
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) updateSplit(event.clientX)
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const left = providerById(activeProviderId)

  return (
    <div className="compare-overlay" ref={overlayRef}>
      <div
        className="compare-map"
        ref={containerRef}
        style={{ clipPath: `inset(0 0 0 ${split * 100}%)` }}
      />
      <div
        className="compare-divider"
        style={{ left: `${split * 100}%` }}
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={10}
        aria-valuemax={90}
        aria-valuenow={Math.round(split * 100)}
        aria-label={tx('Граница сравнения', 'Comparison divider')}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          setSplit((value) =>
            clampSplit(value + (event.key === 'ArrowRight' ? 0.05 : -0.05)),
          )
        }}
      >
        <span className="compare-grip">
          <GripVertical size={14} />
        </span>
      </div>
      <div className="compare-bar">
        <Columns2 size={14} />
        <span className="compare-side">A · {left.short}</span>
        <span className="compare-vs">↔</span>
        <span className="compare-side">B ·</span>
        <select
          value={rightId}
          onChange={(event) => setRightId(event.target.value as ProviderId)}
          aria-label={tx('Вторая подложка', 'Second basemap')}
          title={tx('Вторая подложка', 'Second basemap')}
        >
          {PROVIDERS.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label={tx('Закрыть сравнение', 'Close comparison')}
          title={tx('Закрыть сравнение', 'Close comparison')}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
