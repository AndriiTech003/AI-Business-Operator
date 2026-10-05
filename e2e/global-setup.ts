import type { FullConfig } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from '../apps/eval/dist/index.js';

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  const launched = await launch({ profile: 'e2e', withConsole: true });
  writeFileSync(
    join(launched.logDir, 'stack.json'),
    JSON.stringify({
      agentUrl: launched.agentUrl,
      consoleUrl: launched.consoleUrl,
      bopApiUrl: launched.bopApiUrl,
      bopWebUrl: launched.bopWebUrl,
    }),
  );
  process.env['AIO_E2E_AGENT_URL'] = launched.agentUrl;
  process.env['AIO_E2E_BOP_API_URL'] = launched.bopApiUrl;
  process.env['AIO_E2E_BOP_WEB_URL'] = launched.bopWebUrl ?? '';
  process.env['AIO_E2E_CONSOLE_URL'] = launched.consoleUrl ?? '';
  process.env['AIO_E2E_DEAL_ID'] = launched.meta.ids['deal_trey_expansion'] ?? '';
  process.env['AIO_E2E_DEAL_STAGE'] = String(launched.meta.values['trey_expansion_stage'] ?? '');
  return async () => {
    await launched.stop();
  };
}
