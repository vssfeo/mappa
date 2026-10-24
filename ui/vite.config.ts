import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // MapLibre ships its worker as a separate ES module. Pre-bundling it
  // rewrites the worker URL and the worker fails to load in dev.
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  build: {
    rolldownOptions: {
      output: {
        // Keep the renderer, the map engine and the icon set in separate
        // chunks so the shell can paint before MapLibre is parsed.
        manualChunks(id) {
          if (id.includes('node_modules/maplibre-gl')) return 'maplibre'
          if (
            id.includes('node_modules/react') ||
            id.includes('node_modules/scheduler')
          ) {
            return 'react'
          }
          if (id.includes('node_modules/lucide-react')) return 'icons'
        },
      },
    },
  },
})
