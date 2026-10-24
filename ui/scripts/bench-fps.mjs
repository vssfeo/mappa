/**
 * Viewport benchmark: how many animation frames the map delivers while a
 * scripted pan is in progress. Run on the target machine; headless Chromium
 * results are useful for relative comparisons, not as a product guarantee.
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
  // Linux desktops expose the real GL driver through ANGLE; without these
  // flags headless Chromium quietly falls back to SwiftShader.
  args: (
    process.env.BENCH_ARGS ??
    '--use-gl=angle --use-angle=gl --enable-gpu'
  )
    .split(' ')
    .filter(Boolean),
})
const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } })

try {
  const started = Date.now()
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.maplibregl-canvas')
  const canvasReady = Date.now() - started
  await page.waitForTimeout(2500)

  await page.evaluate(() => {
    window.__benchFrames = 0
    const tick = () => {
      window.__benchFrames += 1
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.waitForTimeout(1000)
  const idleFrames = await page.evaluate(() => window.__benchFrames)
  console.log(`idle fps: ${idleFrames.toFixed(1)}`)
  await page.evaluate(() => {
    window.__benchFrames = 0
  })

  const renderer = await page.evaluate(() => {
    const canvas = document.querySelector('.maplibregl-canvas')
    const context =
      canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')
    if (!context) return { renderer: 'unknown', dpr: devicePixelRatio }
    const info = context.getExtension('WEBGL_debug_renderer_info')
    return {
      renderer: info
        ? context.getParameter(info.UNMASKED_RENDERER_WEBGL)
        : context.getParameter(context.RENDERER),
      dpr: devicePixelRatio,
    }
  })
  console.log(`webgl: ${renderer.renderer} (dpr ${renderer.dpr})`)

  // Drive the drag from inside the page: Playwright mouse.move round-trips
  // add enough latency to distort a 60 Hz measurement.
  const elapsed = await page.evaluate(async () => {
    const canvas = document.querySelector('.maplibregl-canvas')
    if (!canvas) throw new Error('map canvas not found')
    const box = canvas.getBoundingClientRect()
    const center = { x: box.width / 2, y: box.height / 2 }
    const dispatch = (type, x, y) =>
      canvas.dispatchEvent(
        new MouseEvent(type, {
          clientX: x,
          clientY: y,
          bubbles: true,
          button: 0,
          buttons: type === 'mouseup' ? 0 : 1,
        }),
      )
    dispatch('mousedown', center.x, center.y)
    const started = performance.now()
    window.__benchFrames = 0
    await new Promise((resolve) => {
      const step = () => {
        const elapsed = (performance.now() - started) / 1000
        const phase = Math.sin((elapsed / 3) * Math.PI * 2)
        dispatch(
          'mousemove',
          center.x + phase * 220,
          center.y + phase * 90,
        )
        if (elapsed < 3) {
          requestAnimationFrame(step)
        } else {
          dispatch('mouseup', center.x, center.y)
          resolve()
        }
      }
      requestAnimationFrame(step)
    })
    return (performance.now() - started) / 1000
  })

  const frames = await page.evaluate(() => window.__benchFrames)
  const fps = frames / elapsed
  const memory = await page.evaluate(() =>
    performance.memory
      ? {
          used: performance.memory.usedJSHeapSize,
          total: performance.memory.totalJSHeapSize,
        }
      : null,
  )
  console.log(`viewport: 2560x1440`)
  console.log(`canvas ready: ${canvasReady} ms`)
  console.log(`pan frames: ${frames} in ${elapsed.toFixed(2)} s`)
  console.log(`fps: ${fps.toFixed(1)}`)
  if (memory) {
    console.log(
      `js heap: ${(memory.used / 1048576).toFixed(1)} / ${(memory.total / 1048576).toFixed(1)} MiB`,
    )
  }
} finally {
  await browser.close()
  server?.kill()
}
