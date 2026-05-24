// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Proxy /api and /ws to the local FastAPI backend during dev.
// In production, the frontend is served from a CDN and VITE_API_URL
// points to the backend directly (cross-origin), locked down by the
// backend's CORS_ALLOWED_ORIGINS setting.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:8001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      '/ws': {
        target: 'ws://localhost:8001',
        ws: true,
        changeOrigin: true,
        configure: (proxy) => {
          // EPIPE / ECONNRESET are expected when the browser closes the tab or
          // refreshes before the proxy finishes writing — suppress the noise.
          proxy.on('error', (err) => {
            if (!['EPIPE', 'ECONNRESET'].includes(err.code)) {
              console.error('[ws proxy]', err.message)
            }
          })
        },
      },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
          supa: ['@supabase/supabase-js'],
        },
      },
    },
  },
})
