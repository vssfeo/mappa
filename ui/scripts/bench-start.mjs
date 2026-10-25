/**
 * Startup benchmark: how long the app takes to paint the interface and the
 * map, and which long tasks delay it. Headless Chromium numbers are useful
 * for relative comparisons; the product target is measured on real hardware.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const url = process.env.MAPPA_URL ?? 'http://127.0.0.1:4173/'
const projectDir = fileURLToPath(new URL('..', import.meta.url))
let server = null

const reachable = async () => {
  try {
    return (await fetch(url)).ok
  } catch {
    return false
  }
}

if (!process.env.MAPPA_URL && !(await reachable())) {
  server = spawn(
    `${projectDir}/node_modules/.bin/vite`,
    ['preview', '--host', '127.0.0.1', '--port', '4173'],
    { cwd: projectDir, stdio: 'ignore' },
  )
  for (let attempt = 0; attempt < 50 && !(await reachable()); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
if (!(await reachable())) {
  console.error('BENCH FAILED: preview server did not start')
  server?.kill()
  process.exit(1)
}

const browser = await chromium.launch({
  headless: process.env.BENCH_HEADED !== '1',
  args: (
    process.env.BENCH_ARGS ??
    '--use-gl=angle --use-angle=gl --enable-gpu'
  )
    .split(' ')
    .filter(Boolean),
})
const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } })

await page.addInitScript(() => {
  const perf = { longTasks: [], fcp: null, lcp: null }
  window.__startBench = perf
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      perf.longTasks.push({
        start: Math.round(entry.startTime),
        duration: Math.round(entry.duration),
      })
    }
  }).observe({ entryTypes: ['longtask'] })
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === 'first-contentful-paint') perf.fcp = Math.round(entry.startTime)
    }
  }).observe({ entryTypes: ['paint'] })
  new PerformanceObserver((list) => {
    const entries = list.getEntries()
    const last = entries[entries.length - 1]
    if (last) perf.lcp = Math.round(last.startTime)
  }).observe({ entryTypes: ['largest-contentful-paint'] })
})

try {
  const started = Date.now()
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.maplibregl-canvas')
  const canvasReady = Date.now() - started
  await page.waitForTimeout(3000)

  const result = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0]
    const perf = window.__startBench
    return {
      fcp: perf.fcp,
      lcp: perf.lcp,
      domContentLoaded: navigation
        ? Math.round(navigation.domContentLoadedEventEnd)
        : null,
      load: navigation ? Math.round(navigation.loadEventEnd) : null,
      longTasks: perf.longTasks,
      heap: performance.memory
        ? {
            used: Math.round(performance.memory.usedJSHeapSize / 1048576),
            total: Math.round(performance.memory.totalJSHeapSize / 1048576),
          }
        : null,
      bootPlaceholder: Boolean(document.getElementById('boot')),
      canvasSize: (() => {
        const canvas = document.querySelector('.maplibregl-canvas')
        const box = canvas?.getBoundingClientRect()
        return box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'none'
      })(),
    }
  })

  const longTasks = result.longTasks
    .filter((task) => task.duration >= 50)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5)

  console.log(`fcp: ${result.fcp ?? '?'} ms`)
  console.log(`lcp: ${result.lcp ?? '?'} ms`)
  console.log(`domcontentloaded: ${result.domContentLoaded ?? '?'} ms`)
  console.log(`load: ${result.load ?? '?'} ms`)
  console.log(`map canvas: ${canvasReady} ms (${result.canvasSize})`)
  console.log(
    `long tasks: ${longTasks.length ? longTasks.map((task) => `${task.duration}ms @${task.start}`).join(', ') : 'none'}`,
  )
  console.log(`boot placeholder: ${result.bootPlaceholder ? 'still present' : 'replaced'}`)
  if (result.heap) console.log(`js heap: ${result.heap.used} / ${result.heap.total} MiB`)
} finally {
  await browser.close()
  server?.kill()
}
