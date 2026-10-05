import { defineConfig } from 'vitest/config';
import { defaultClientConditions } from 'vite';

export default defineConfig({
  resolve: { conditions: ['source', ...defaultClientConditions] },
  test: { include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], environment: 'node' },
});
