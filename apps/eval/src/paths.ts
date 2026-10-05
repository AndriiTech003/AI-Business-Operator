import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function repoRoot(): string {
  if (process.env['AIO_ROOT'] !== undefined && process.env['AIO_ROOT'] !== '') return resolve(process.env['AIO_ROOT']);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'scenarios')) && existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = resolve(dir, '..');
  }
  return process.cwd();
}

export const paths = {
  root: () => repoRoot(),
  scenarios: () => join(repoRoot(), 'scenarios'),
  fixtures: () => join(repoRoot(), 'scenarios', 'fixtures'),
  cassettes: () => join(repoRoot(), 'scenarios', 'cassettes'),
  rubrics: () => join(repoRoot(), 'scenarios', 'rubrics'),
  policies: () => join(repoRoot(), 'scenarios', 'policies'),
  reports: () => join(repoRoot(), 'docs', 'eval'),
  logs: () => join(repoRoot(), '.eval', 'logs'),
};
