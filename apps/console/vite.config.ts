import { defineConfig, defaultClientConditions, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const embedDevEntry: Plugin = {
  name: 'aio-embed-dev-entry',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url !== undefined && req.url.startsWith('/embed/ask-operator.js')) req.url = '/src/embed/ask-operator.ts';
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), embedDevEntry],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: { host: '127.0.0.1', port: 4610, strictPort: true },
  preview: { host: '127.0.0.1', port: 4611, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, sourcemap: true },
});
