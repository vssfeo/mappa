/** Live GNSS marker, accuracy footprint and in-progress track on the map. */

import { useEffect, useRef } from 'react'
import type { FeatureCollection } from 'geojson'
import {
  Marker,
  type GeoJSONSource,
  type Map as MapLibreMap,
} from 'maplibre-gl'
import { circlePolygon, destination } from './geo.ts'
import { useGpsStore } from './gps.ts'

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }
const ACCURACY_COLOR = '#4cc9f0'
const TRACK_COLOR = '#3ddc97'

const accuracyData = (
  lon: number,
  lat: number,
  accuracy: number,
) => {
  const radius = Math.min(10_000, Math.max(0, accuracy))
  if (radius <= 0) return EMPTY
  const ring = circlePolygon(
    [lon, lat],
    destination([lon, lat], 0, radius),
    64,
  )
  if (ring.length < 3) return EMPTY
  return {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'Polygon' as const,
          coordinates: [[...ring, ring[0]]],
        },
      },
    ],
  }
}

export function GpsLayer({ map }: { map: MapLibreMap | null }) {
  const fix = useGpsStore((state) => state.fix)
  const samples = useGpsStore((state) => state.samples)
  const follow = useGpsStore((state) => state.follow)
  const markerRef = useRef<Marker | null>(null)

  useEffect(() => {
    if (!map) return
    const anchor = map.getLayer('selection-fill')
      ? 'selection-fill'
      : undefined
    if (!map.getSource('gps-accuracy')) {
      map.addSource('gps-accuracy', { type: 'geojson', data: EMPTY })
    }
    if (!map.getSource('gps-track')) {
      map.addSource('gps-track', { type: 'geojson', data: EMPTY })
    }
    if (!map.getLayer('gps-accuracy-fill')) {
      map.addLayer(
        {
          id: 'gps-accuracy-fill',
          type: 'fill',
          source: 'gps-accuracy',
          paint: {
            'fill-color': ACCURACY_COLOR,
            'fill-opacity': 0.08,
          },
        },
        anchor,
      )
    }
    if (!map.getLayer('gps-accuracy-line')) {
      map.addLayer(
        {
          id: 'gps-accuracy-line',
          type: 'line',
          source: 'gps-accuracy',
          paint: {
            'line-color': ACCURACY_COLOR,
            'line-width': 1,
            'line-opacity': 0.55,
            'line-dasharray': [2, 2],
          },
        },
        anchor,
      )
    }
    if (!map.getLayer('gps-track-line')) {
      map.addLayer(
        {
          id: 'gps-track-line',
          type: 'line',
          source: 'gps-track',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': TRACK_COLOR,
            'line-width': 3,
          },
        },
        anchor,
      )
    }

    const element = document.createElement('div')
    element.className = 'gps-marker'
    element.setAttribute('aria-hidden', 'true')
    const heading = document.createElement('span')
    heading.className = 'gps-marker-heading'
    const dot = document.createElement('span')
    dot.className = 'gps-marker-dot'
    element.append(heading, dot)
    element.style.display = 'none'
    const marker = new Marker({ element, anchor: 'center' })
      .setLngLat([0, 0])
      .addTo(map)
    markerRef.current = marker

    return () => {
      marker.remove()
      markerRef.current = null
      for (const id of ['gps-track-line', 'gps-accuracy-line', 'gps-accuracy-fill']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of ['gps-track', 'gps-accuracy']) {
        if (map.getSource(id)) map.removeSource(id)
      }
    }
  }, [map])

  useEffect(() => {
    if (!map) return
    const track = map.getSource('gps-track') as GeoJSONSource | undefined
    if (track) {
      track.setData(
        samples.length >= 2
          ? {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: samples.map((sample) => [
                  sample.lon,
                  sample.lat,
                ]),
              },
            }
          : EMPTY,
      )
    }
    const accuracy = map.getSource('gps-accuracy') as
      | GeoJSONSource
      | undefined
    accuracy?.setData(
      fix ? accuracyData(fix.lon, fix.lat, fix.accuracy) : EMPTY,
    )

    const marker = markerRef.current
    if (!marker) return
    const element = marker.getElement()
    if (!fix) {
      element.style.display = 'none'
      return
    }
    element.style.display = ''
    marker.setLngLat([fix.lon, fix.lat])
    const arrow = element.querySelector<HTMLElement>('.gps-marker-heading')
    if (arrow) {
      arrow.style.transform =
        fix.heading === null ? 'rotate(0deg)' : `rotate(${fix.heading}deg)`
      arrow.style.opacity = fix.heading === null ? '0' : '1'
    }
  }, [map, fix, samples])

  useEffect(() => {
    if (!map || !follow || !fix) return
    map.easeTo({
      center: [fix.lon, fix.lat],
      zoom: Math.max(map.getZoom(), 15),
      duration: 350,
    })
  }, [map, follow, fix])

  return null
}
