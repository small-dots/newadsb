import { defineConfig } from 'vite';

// Keep the downloaded AirNav-derived assets in their existing local directory.
// Vite exposes this folder at the web root during development and builds it into dist/.
export default defineConfig({
  publicDir: 'airnavradar-models'
});
