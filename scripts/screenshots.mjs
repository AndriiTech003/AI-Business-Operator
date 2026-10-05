import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { launch } from '../apps/eval/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs/images');
mkdirSync(OUT, { recursive: true });

const only = process.env.SCREENSHOTS ?? 'all';
const stack = await launch({ profile: 'dev', withConsole: true });
const browser = await chromium.launch();
let code = 0;

async function embedShot(page) {
  const web = stack.bopWebUrl;
  await page.goto(`${web}/login`);
  await page.getByTestId('login-email').fill('maria@demo.dev');
  await page.getByTestId('login-password').fill('demo1234');
  await page.getByTestId('login-submit').click();
  await page.getByTestId('nav-companies').waitFor();
  await page.goto(`${web}/deals/${stack.meta.ids.deal_trey_expansion}`);
  await page.getByTestId('ask-operator-button').click();
  await page.getByTestId('ask-operator-email').fill('maria@demo.dev');
  await page.getByTestId('ask-operator-password').fill('demo1234');
  await page.getByTestId('ask-operator-sign-in').click();
  await page.getByTestId('ask-operator-input').fill('Which stage is this deal in?');
  await page.getByTestId('ask-operator-send').click();
  await page.getByTestId('ask-operator-status').filter({ hasText: 'completed' }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'ask-operator-in-05.png') });
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  if (only === 'embed') {
    await embedShot(page);
    console.log(`screenshot written to ${OUT}`);
  } else {
    const base = stack.consoleUrl;
    await page.goto(`${base}/#/login`);
    await page.locator('input[name=email]').fill('maria@demo.dev');
    await page.locator('input[name=password]').fill('demo1234');
    await page.locator('button[type=submit]').click();
    await page.getByTestId('goal-input').waitFor();

    const run = async (goal) => {
      await page.goto(`${base}/#/chat`);
      await page.getByTestId('goal-input').fill(goal);
      await page.getByTestId('run-goal').click();
      await page.waitForURL(/#\/runs\//);
    };

    await run("Find leads we haven't contacted in over 7 days and prepare follow-up emails.");
    await page.getByTestId('approval-batch').waitFor({ timeout: 60_000 });
    await page.getByTestId('approval-batch').getByTestId('taint-highlight').first().waitFor({ timeout: 60_000 });
    await page.getByTestId('approval-batch').getByTestId('taint-highlight').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(OUT, 'approval-batch.png') });
    await page.getByTestId('timeline').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(OUT, 'timeline.png') });

    await run('Void invoice INV-2026-0003.');
    await page.getByTestId('run-summary').waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, 'forbidden.png') });

    await page.goto(`${base}/#/policy`);
    await page.getByTestId('policy-editor').waitFor();
    await page.getByTestId('simulate-tool').selectOption('send_email');
    await page.getByTestId('simulate-args').fill('{"to": ["x@evil.test"]}');
    await page.getByTestId('simulate-run').click();
    await page.getByTestId('simulate-result').waitFor();
    await page.screenshot({ path: join(OUT, 'policy.png'), fullPage: true });

    await page.goto(`${base}/#/eval`);
    await page.waitForTimeout(1500);
    const first = page.locator('a[href^="#/eval/"]').first();
    if (await first.count()) {
      await first.click();
      await page.waitForTimeout(1500);
    }
    await page.screenshot({ path: join(OUT, 'eval-dashboard.png'), fullPage: false });
    await embedShot(await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }));
    console.log(`screenshots written to ${OUT}`);
  }
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  await browser.close();
  await stack.stop();
}
process.exit(code);
