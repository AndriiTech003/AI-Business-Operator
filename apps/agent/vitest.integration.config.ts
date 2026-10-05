import { defineConfig } from 'vitest/config';
import { workspaceAlias } from '../../vitest.shared.ts';

export default defineConfig({
  resolve: { alias: workspaceAlias },
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 180000,
    hookTimeout: 300000,
    fileParallelism: false,
  },
});
