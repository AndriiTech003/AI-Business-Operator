import { defineConfig } from 'vitest/config';
import { workspaceAlias } from '../../vitest.shared.ts';

export default defineConfig({
  resolve: { alias: workspaceAlias },
  test: { include: ['test/**/*.test.ts'] },
});
