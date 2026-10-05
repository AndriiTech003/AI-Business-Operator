import { expect, test } from '@playwright/test';
import { login, mailTo, runGoal } from './helpers';

test('goal → timeline → approval batch (deselect one, edit one) → approve → e-mails in Mailpit', async ({ page }) => {
  const since = Date.now();
  await login(page);
  await runGoal(page, 'Send payment reminders for all invoices that are more than 30 days overdue.');
  const timeline = page.getByTestId('timeline');
  await expect(timeline.locator('[data-testid=step][data-tool=list_invoices]').first()).toBeVisible();
  await expect(timeline.getByTestId('policy-badge').filter({ hasText: 'auto' }).first()).toBeVisible();
  await expect(timeline.getByTestId('policy-badge').filter({ hasText: 'approval' }).first()).toBeVisible();
  await expect(page.getByTestId('run-status')).toContainText(/awaiting/i);

  const batch = page.getByTestId('approval-batch');
  const cards = batch.locator('[data-testid=proposal][data-tool=send_email]');
  await expect(cards).toHaveCount(5);
  const recipients: string[] = [];
  for (let i = 0; i < 5; i += 1)
    recipients.push(
      (await cards.nth(i).getByTestId('email-preview').innerText()).match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0] ?? '',
    );
  expect(recipients.every((r) => r.includes('@'))).toBe(true);

  await cards.nth(0).getByTestId('proposal-select').uncheck();
  const subject = `Payment reminder – updated by a human ${since}`;
  await cards.nth(1).getByTestId('proposal-edit').click();
  await cards.nth(1).getByTestId('edit-subject').fill(subject);
  await cards
    .nth(1)
    .getByTestId('edit-body')
    .fill(
      'Hello,\n\nA friendly reminder that this invoice is still open. Please let us know if anything is unclear.\n\nBest regards,\nMaria Lopez\nAcme Corp',
    );
  await cards.nth(1).getByTestId('edit-save').click();
  await batch.getByTestId('approve-selected').click();

  await expect(page.getByTestId('run-status')).toContainText(/completed/i, { timeout: 60_000 });
  await expect(page.getByTestId('run-summary')).toContainText(/Sent 4 reminders/);

  await expect
    .poll(
      async () => (await Promise.all(recipients.slice(1).map((r) => mailTo(r, since)))).every((m) => m.length === 1),
      { timeout: 60_000 },
    )
    .toBe(true);
  const edited = await mailTo(recipients[1] as string, since);
  expect(edited[0]?.Subject).toBe(subject);
  expect(await mailTo(recipients[0] as string, since)).toHaveLength(0);
});
