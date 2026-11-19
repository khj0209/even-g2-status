import { defineConfig } from 'vite';

// base: './' keeps asset paths relative so the built folder works when
// packaged into an .ehpk and loaded by the Even App WebView.
export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  build: { outDir: 'dist', target: 'es2020' },
});
