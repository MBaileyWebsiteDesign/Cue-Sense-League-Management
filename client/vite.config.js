import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The static demo build (npm run build:demo, see package.json / README) is
// published to GitHub Pages at a repo-name subpath rather than a domain
// root, so every asset URL needs that prefix baked in - a normal build
// (npm run build, served by the Express server itself at "/") stays at "/".
const isDemoBuild = process.env.VITE_DEMO_MODE === 'true';

export default defineConfig({
  plugins: [
    react(),
    // Service worker: precaches the built app shell (JS/CSS/index.html) so
    // reopening the app on a slow/patchy mobile connection shows the UI
    // instantly instead of re-downloading everything, and
    // stale-while-revalidate-caches the public, unauthenticated embed
    // endpoints (overlay/arena, and the public league/division table,
    // fixtures & bracket pages - see the "Public, unauthenticated" comments
    // in src/api.js) so those screens also render immediately from cache
    // while quietly refreshing in the background.
    //
    // Deliberately NOT caching any authenticated /api/* GET response: this
    // app runs on shared venue devices where different players log in on
    // the same browser (see the walk-in / ad-hoc game features), and a
    // service worker cache keyed by URL alone (not by Authorization header)
    // could show one player's cached data to the next person on that
    // device. Skipped entirely for the demo build (GitHub Pages, subpath
    // base, no real API to talk to).
    !isDemoBuild &&
      VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          name: 'Cue Sense - League Management',
          short_name: 'Cue Sense',
          start_url: '/',
          display: 'standalone',
          background_color: '#ffffff',
          theme_color: '#ffffff',
          icons: [
            { src: 'favicon.png', sizes: '64x64', type: 'image/png' },
            { src: 'logo.png', sizes: '88x88', type: 'image/png' },
          ],
        },
        workbox: {
          navigateFallback: '/index.html',
          runtimeCaching: [
            {
              urlPattern: /^\/api\/(public|overlay)\//,
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'cue-sense-public-api',
                expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 },
              },
            },
          ],
        },
      }),
  ].filter(Boolean),
  base: isDemoBuild ? '/Cue-Sense-League-Management/' : '/',
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
