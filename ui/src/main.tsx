import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setWorkerUrl } from 'maplibre-gl'
// Vite must copy MapLibre's worker next to the bundle; the library's default
// `new URL(..., import.meta.url)` points at a file the bundler never emits.
import maplibreWorker from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import './index.css'
import App from './App.tsx'

setWorkerUrl(maplibreWorker)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
