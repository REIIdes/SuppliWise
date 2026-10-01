import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// ── Response headers the CSP <meta> in index.html structurally cannot carry ──
//
// The policy in index.html covers everything a meta tag is allowed to express.
// `frame-ancestors` is the one that matters here and it is NOT: per spec it is
// IGNORED when delivered in a `<meta http-equiv>` and is honoured only as a real
// response header. Helmet already sets it for the API origin, so without this
// the app origin had no framing protection at all — any site could iframe
// SuppliWise and clickjack it.
//
// Multiple CSP policies are enforced as an INTERSECTION, so shipping a
// frame-ancestors-only header alongside the existing meta policy adds exactly
// this one restriction and nothing else. It is deliberately scoped that way: it
// cannot loosen the meta policy, and it cannot break the app.
//
// SCOPE — read this before assuming production is covered. This applies to
// `vite dev` and `vite preview` only. `vite build` emits a static `dist/` that
// some other server hands out, and no host config exists in this repo to do it
// for us, so whoever deploys it must send these same headers. Tracked as a
// manual action in SECURITY_AUDIT_REPORT.md §9.
const securityHeaders = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // `vite build` and `vite dev` otherwise share one node_modules/.vite cache,
  // so a build run while the dev server is up can rewrite state the running
  // server still depends on (observed: orphaned deps_temp_* folders and a
  // deps/ tree that stopped matching the committed metadata). Giving each
  // command its own cache keeps them independent.
  cacheDir: command === 'build' ? 'node_modules/.vite-build' : 'node_modules/.vite',
  // ── If a dependency fails to load in dev ("Failed to fetch dynamically
  // imported module: …/node_modules/.vite/deps/<pkg>.js?v=<hash>"), the fix is:
  //
  //     stop the dev server,  rm -rf node_modules/.vite,  start it again
  //
  // The cause is almost always a package INSTALLED WHILE THE SERVER WAS ALREADY
  // RUNNING. The running optimizer has never pre-bundled it, so the first use
  // forces a re-optimize mid-session; that changes the browser hash, and every
  // `?v=` URL the already-open page holds immediately stops resolving (504).
  // Repeated interrupted runs leave orphaned `node_modules/.vite/deps_temp_*`
  // folders and can end with no committed `deps/` tree at all — which is the
  // state where the server 504s every dependency and nothing renders.
  //
  // Editing a package in node_modules, or `npm install` anything, has the same
  // effect. Restarting is the fix; there is nothing to repair in the config.
  optimizeDeps: {
    // EVERY package that is reached through a DYNAMIC `import()` must be listed
    // here. The startup scan only sees static imports, so a dep first reached at
    // click-time is discovered mid-session, which forces Vite to re-optimize.
    // Re-optimizing changes `browserHash`, and every module URL the loaded page
    // already holds (`...?v=<old hash>`) stops resolving — the server answers
    // 504 "Outdated Optimize Dep", and the browser reports:
    //
    //   Failed to fetch dynamically imported module:
    //   http://localhost:5173/node_modules/.vite/deps/<name>.js?v=<old hash>
    //
    // The page is then stuck: the module it wants is gone, and the fix is a
    // reload nobody thinks to do. (Repeated interrupted re-optimizes also leave
    // orphaned `deps_temp_*` folders behind, which is how a cache ends up
    // without a committed `deps/` tree at all.)
    //
    // Pre-bundling them up front keeps ONE hash for the whole session. Relative
    // imports are unaffected — they are app source, not deps, and need no entry.
    //
    // `optimizeDeps.include` completeness is enforced by
    // src/utils/optimizeDepsInclude.test.js, because this has now bitten twice
    // (jspdf, then @simplewebauthn/browser) and the failure looks like an
    // unrelated browser error rather than a missing config line.
    include: [
      'jspdf',
      'jspdf-autotable',
      // WebAuthn. Imported lazily in api.js so the ~30 KB browser SDK is not in
      // the initial bundle for the majority of people who never touch a passkey.
      '@simplewebauthn/browser',
    ],
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
    headers: securityHeaders,
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
  // `vite preview` serves the real production build, so it needs the same
  // headers as dev. Without this the closest thing to production — the thing you
  // would actually check a build against — was the one origin with no framing
  // protection at all.
  preview: {
    headers: securityHeaders,
  },
}))