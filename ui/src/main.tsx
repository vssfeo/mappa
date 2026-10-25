import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setWorkerUrl } from 'maplibre-gl'
// Vite must copy MapLibre's worker next to the bundle; the library's default
// `new URL(..., import.meta.url)` points at a file the bundler never emits.
import maplibreWorker from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import './index.css'
import App from './App.tsx'
import { reportJsError } from './crash.ts'

setWorkerUrl(maplibreWorker)

// Recorded only when the user enabled crash reports; the Rust side ignores
// these calls otherwise.
window.addEventListener('error', (event) => {
  reportJsError(event.message, event.error?.stack ?? '')
})
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  reportJsError(
    reason instanceof Error ? reason.message : String(reason),
    reason instanceof Error ? (reason.stack ?? '') : '',
  )
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
