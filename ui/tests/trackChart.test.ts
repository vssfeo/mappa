import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

import { buildTrackProfile } from '../src/trackProfile.ts'

test('renders an interactive elevation and speed profile', async () => {
  const server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  })
  try {
    const { TrackChart } = await server.ssrLoadModule('/src/TrackChart.tsx')
    const model = buildTrackProfile(
      [
        [37.6, 55.7],
        [37.7, 55.8],
        [37.8, 55.9],
      ],
      {
        elevations: [120, 220, 150],
        times: [
          '2026-01-01T10:00:00Z',
          '2026-01-01T10:20:00Z',
          '2026-01-01T10:40:00Z',
        ],
      },
    )
    const html = renderToStaticMarkup(
      createElement(TrackChart, { model, progress: 0.5, onSeek() {} }),
    )
    assert.match(html, /class="track-profile-chart"/)
    assert.match(html, /role="slider"/)
    assert.match(html, /aria-valuenow="50"/)
    assert.match(html, /class="track-profile-area"/)
    assert.match(html, /class="track-profile-elevation"/)
    assert.match(html, /class="track-profile-speed"/)
    assert.match(html, /Высота 220 m/)
    assert.match(html, /Скорость 38 km\/h/)
    assert.match(html, /↑ 100 m · ↓ 70 m/)
  } finally {
    await server.close()
  }
})

test('hides the speed layer when a track has no timestamps', async () => {
  const server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  })
  try {
    const { TrackChart } = await server.ssrLoadModule('/src/TrackChart.tsx')
    const model = buildTrackProfile(
      [
        [37.6, 55.7],
        [37.7, 55.8],
      ],
      { elevations: [120, 220], times: [null, null] },
    )
    const html = renderToStaticMarkup(
      createElement(TrackChart, { model, progress: 0, onSeek() {} }),
    )
    assert.match(html, /track-profile-elevation/)
    assert.doesNotMatch(html, /track-profile-speed/)
    assert.doesNotMatch(html, /Скорость/)
    assert.doesNotMatch(html, /track-profile-dot is-speed/)
  } finally {
    await server.close()
  }
})
