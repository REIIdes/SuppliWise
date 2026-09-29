import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // `vite build` and `vite dev` otherwise share one node_modules/.vite cache,
  // so a build run while the dev server is up can rewrite state the running
  // server still depends on (observed: orphaned deps_temp_* folders and a
  // deps/ tree that stopped matching the committed metadata). Giving each
  // command its own cache keeps them independent.
  cacheDir: command === 'build' ? 'node_modules/.vite-build' : 'node_modules/.vite',
  optimizeDeps: {
    // jspdf is pulled in by a DYNAMIC import when the user clicks Export, so
    // Vite's startup scan never discovers it. The first click then triggers a
    // mid-session re-optimize, which bumps `browserHash`; the page that is
    // already loaded keeps requesting the previous `?v=<hash>`, and the server
    // answers 504 "Outdated Optimize Dep" - surfacing in the browser as
    // "Failed to fetch dynamically imported module: .../deps/jspdf.js?v=...".
    // Pre-bundling them up front keeps one hash for the whole session.
    include: ['jspdf', 'jspdf-autotable'],
  },
  plugins: [
    react(),
    // basicSsl(), // DISABLED: Causes Mixed Content errors with HTTP backend
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'robots.txt', 'apple-touch-icon.png'],
      manifest: {
        name: 'SuppliWise',
        short_name: 'SuppliWise',
        description: 'AI-powered personalized supplement recommendations and wellness tracking',
        theme_color: '#22c55e',
        background_color: '#f0faf0',
        display: 'standalone',
        orientation: 'portrait-primary',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable'
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      // NEVER enable a service worker against the dev server: a worker running
      // in front of Vite serves cached bundles over live edits — stale pages
      // that no code change could reach until the worker was unregistered.
      // Dev always loads fresh from Vite; only the production build gets a
      // worker (vite-plugin-pwa's own precached one).
      devOptions: {
        enabled: false,
        type: 'module',
        navigateFallback: 'index.html'
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        navigateFallback: null,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'gstatic-fonts-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          }
          // NOTE: /api responses are intentionally never cached. Caching them
          // caused stale dashboard/intake data (e.g. mark-taken updates
          // appearing not to work until the cache expired).
        ]
      }
    })
  ],
  server: {
    host: 'localhost',
    // Fail loudly instead of silently moving to 5174 when something is already
    // holding 5173. A shifted port leaves you reading a stale browser tab
    // pointed at a dead port, and running a second Vite process against the
    // same node_modules/.vite cache corrupts the dependency optimizer.
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
}))