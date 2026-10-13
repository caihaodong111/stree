import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@stree/shared': new URL('../packages/shared/src/index.ts', import.meta.url).pathname,
    },
  },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8000' } },
});
