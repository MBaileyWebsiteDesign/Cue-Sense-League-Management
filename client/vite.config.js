import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The static demo build (npm run build:demo, see package.json / README) is
// published to GitHub Pages at a repo-name subpath rather than a domain
// root, so every asset URL needs that prefix baked in - a normal build
// (npm run build, served by the Express server itself at "/") stays at "/".
const isDemoBuild = process.env.VITE_DEMO_MODE === 'true';

export default defineConfig({
  plugins: [react()],
  base: isDemoBuild ? '/Cue-Sense-Pool-Management/' : '/',
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
