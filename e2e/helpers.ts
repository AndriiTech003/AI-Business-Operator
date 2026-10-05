import { expect, type Page } from '@playwright/test';

export async function login(page: Page, email = 'maria@demo.dev'): Promise<void> {
  await page.goto('/#/login');
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill('demo1234');
  await page.locator('button[type=submit]').click();
  await expect(page.getByTestId('goal-input')).toBeVisible();
}

export async function runGoal(page: Page, goal: string): Promise<void> {
  await page.goto('/#/chat');
  await page.getByTestId('goal-input').fill(goal);
  await page.getByTestId('run-goal').click();
  await expect(page).toHaveURL(/#\/runs\/[0-9a-f-]{36}/);
}

export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
  Created: string;
}

export async function mailTo(
  address: string,
  since: number,
  subjectContains = 'Payment reminder',
): Promise<MailpitMessage[]> {
  const res = await fetch(
    `http://127.0.0.1:8025/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=50`,
  );
  const json = (await res.json()) as { messages?: MailpitMessage[] };
  return (json.messages ?? []).filter(
    (m) => Date.parse(m.Created) >= since - 1000 && m.Subject.includes(subjectContains),
  );
}
