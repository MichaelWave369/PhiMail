import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_PAGES === 'true' ? '/PhiMail/' : '/',
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
                     '/auth': { target: 'http://127.0.0.1:8787', changeOrigin: false },
                     '/field-registry': { target: 'http://127.0.0.1:8769', changeOrigin: false, rewrite: p => p.replace(/^\/field-registry/, '') } } },
  test: { environment: 'node', include: ['src/**/*.test.js'] }
});
