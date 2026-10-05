import { expect, test } from '@playwright/test';

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set by the e2e global setup`);
  return v;
}

test('"Ask operator" on a project 05 deal page: sign in inside the panel and start a run with the deal as context', async ({
  page,
}) => {
  const web = env('AIO_E2E_BOP_WEB_URL');
  const agentUrl = env('AIO_E2E_AGENT_URL');
  const consoleUrl = env('AIO_E2E_CONSOLE_URL');
  const dealId = env('AIO_E2E_DEAL_ID');
  const stage = env('AIO_E2E_DEAL_STAGE');

  const config = (await (await fetch(`${env('AIO_E2E_BOP_API_URL')}/v1/app-config`)).json()) as {
    operator: { scriptUrl: string; agentUrl: string; consoleUrl: string } | null;
  };
  expect(config.operator).toEqual({
    scriptUrl: `${consoleUrl}/embed/ask-operator.js`,
    agentUrl,
    consoleUrl,
  });

  await page.goto(`${web}/login`);
  await page.getByTestId('login-email').fill('maria@demo.dev');
  await page.getByTestId('login-password').fill('demo1234');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('nav-companies')).toBeVisible();

  await page.goto(`${web}/deals/${dealId}`);
  await expect(page.getByTestId('record-title')).toBeVisible();
  await expect(page.getByTestId('operator-slot')).toHaveAttribute('data-status', 'ready');
  const button = page.getByTestId('ask-operator-button');
  await expect(button).toBeVisible();
  await expect(button).toHaveText(/Ask operator/);
  await button.click();
  const panel = page.getByTestId('ask-operator-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(`deal: ${await page.getByTestId('record-title').innerText()}`);

  await expect(page.getByTestId('ask-operator-login')).toBeVisible();
  await page.getByTestId('ask-operator-email').fill('maria@demo.dev');
  await page.getByTestId('ask-operator-password').fill('demo1234');
  await page.getByTestId('ask-operator-sign-in').click();
  await expect(page.getByTestId('ask-operator-login')).toBeHidden();

  await page.getByTestId('ask-operator-input').fill('Which stage is this deal in?');
  await page.getByTestId('ask-operator-send').click();
  await expect(page.getByTestId('ask-operator-status')).toHaveText('completed', { timeout: 60_000 });
  await expect(page.getByTestId('ask-operator-text')).toContainText(`is in the ${stage} stage`);
  await expect(page.getByTestId('ask-operator-step').filter({ hasText: 'get_deal' })).toContainText('auto');
  const href = await page.getByTestId('ask-operator-link').getAttribute('href');
  const runId = /#\/runs\/([0-9a-f-]{36})$/.exec(href ?? '')?.[1];
  expect(href?.startsWith(`${consoleUrl}/#/runs/`)).toBe(true);
  expect(runId).toBeDefined();

  const login = (await (
    await fetch(`${agentUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'maria@demo.dev', password: 'demo1234' }),
    })
  ).json()) as { token: string };
  const run = (await (
    await fetch(`${agentUrl}/runs/${runId}`, { headers: { authorization: `Bearer ${login.token}` } })
  ).json()) as { status: string; context: { source: string; record: { type: string; id: string } } };
  expect(run.status).toBe('completed');
  expect(run.context.source).toBe('embed');
  expect(run.context.record).toMatchObject({ type: 'deal', id: dealId });
});
