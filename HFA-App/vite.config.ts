import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file build: the whole app (incl. inlined Web Workers) is emitted as
// dist/index.html so it runs fully offline, even from file://
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  worker: { format: 'iife' },
  build: { target: 'es2020', chunkSizeWarningLimit: 5000 },
});
