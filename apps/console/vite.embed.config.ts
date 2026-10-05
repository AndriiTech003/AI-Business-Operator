import { defineConfig, defaultClientConditions } from 'vite';

const entry = decodeURIComponent(new URL('./src/embed/ask-operator.ts', import.meta.url).pathname);

export default defineConfig({
  publicDir: false,
  resolve: { conditions: ['source', ...defaultClientConditions] },
  build: {
    target: 'es2022',
    outDir: 'dist/embed',
    emptyOutDir: false,
    sourcemap: true,
    lib: { entry, formats: ['es'], fileName: () => 'ask-operator.js' },
  },
});
