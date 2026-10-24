import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// CSP only in the packaged page: the dev server needs inline scripts for React refresh.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; worker-src 'self' blob:";
const csp = {
  name: 'csp',
  apply: 'build' as const,
  transformIndexHtml: (html: string) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

export default defineConfig({
  plugins: [react(), csp],
  base: './',
  server: { port: 5174, strictPort: true },
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 8000 },
});
