import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/migrate.ts', 'src/seed.ts', 'src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: true,
  onSuccess: 'rm -rf dist/migrations && cp -R src/db/migrations dist/migrations',
});
