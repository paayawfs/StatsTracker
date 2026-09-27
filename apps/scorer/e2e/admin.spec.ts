import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { btn, pickStartersAndStart, player } from './fixtures';

const roster = (club: string) => [4, 5, 6, 7, 8, 9].map((j) => `${j} ${club} ${j}`).join('\n');

test('admin: set up a league, run a game with a scorer, lock it, export, season stats, latency', async ({ browser }) => {
  const admin = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage();
  const email = `admin-${Date.now()}@example.com`;

  // Account + league.
  await admin.goto('/admin');
  await admin.getByLabel('Email').fill(email);
  await admin.getByLabel('Password').fill('correct-horse-battery');
  await btn(admin, 'Create account').click();
  await expect(admin.getByRole('heading', { name: 'Your leagues' })).toBeVisible();
  await admin.getByPlaceholder('League name').fill('Accra Community League');
  await btn(admin, 'Create league').click();
  await admin.getByRole('button', { name: 'Accra Community League' }).click();

  // Rule set, season, teams and pasted rosters.
  await btn(admin, 'Rule sets').click();
  await btn(admin, 'New from FIBA').click();
  await btn(admin, 'Save rule set').click();
  await expect(admin.getByRole('button', { name: 'FIBA' })).toBeVisible();
  await btn(admin, 'Seasons').click();
  await admin.getByPlaceholder('Season name, e.g. 2026/27').fill('2026');
  await btn(admin, 'Add season').click();
  await expect(admin.getByText('2026')).toBeVisible();
  await btn(admin, 'Teams & players').click();
  for (const club of ['Lions', 'Tigers']) {
    await admin.getByPlaceholder('Team name').fill(club);
    await btn(admin, 'Add team').click();
    const card = admin.getByTestId(`team-${club}`);
    await card.getByRole('textbox').fill(roster(club));
    await card.getByRole('button', { name: 'Add 6 players' }).click();
    await expect(card.getByText('6 players')).toBeVisible();
  }

  // Game + code.
  await btn(admin, 'Games').click();
  await admin.getByLabel('Team A (home)').selectOption({ label: 'Lions' });
  await admin.getByLabel('Team B (away)').selectOption({ label: 'Tigers' });
  await admin.getByLabel('Season').selectOption({ label: '2026' });
  await admin.getByLabel('Rule set').selectOption({ label: 'FIBA' });
  await btn(admin, 'Create game').click();
  await expect(admin.getByText('Not started')).toBeVisible();
  await btn(admin, 'New scorer code').click();
  const code = (await admin.locator('code.code').first().textContent())!.trim();
  expect(code).toMatch(/^[A-Z2-9]{8}$/);

  // A scorer joins with the code and plays a little.
  const scorer = await (await browser.newContext({ viewport: { width: 1180, height: 820 } })).newPage();
  await scorer.goto('/');
  await scorer.getByLabel('Game code').fill(code);
  await btn(scorer, 'Join game').click();
  await pickStartersAndStart(scorer);
  await player(scorer, 'A', 4).click();
  await btn(scorer, '3 ✓').click();
  await btn(scorer, 'Skip').click();
  await player(scorer, 'B', 5).click();
  await btn(scorer, '2 ✓').click();
  await btn(scorer, 'Skip').click();
  await expect(scorer.getByText('to sync')).toHaveCount(0, { timeout: 10_000 });
  await scorer.evaluate(() => (window as unknown as { __scorer: { flushLatency: () => Promise<void> } }).__scorer.flushLatency());

  // Admin sees the game live, with latency samples.
  await btn(admin, '‹ Games').click();
  await admin.getByRole('button', { name: 'Lions vs Tigers' }).click();
  await expect(admin.getByRole('heading', { name: 'Lions 3 – 2 Tigers' })).toBeVisible();
  await expect(admin.getByTestId('latency')).toContainText('tap → own screen');

  // Export CSV.
  const [download] = await Promise.all([admin.waitForEvent('download'), btn(admin, 'Export CSV').click()]);
  const csv = readFileSync((await download.path())!, 'utf8');
  expect(csv.split('\r\n')[0]).toBe('seq,id,period,gameClock,type,role,deviceId,deviceSeq,wallClock,payload');
  expect(csv).toContain(',shot,single,');

  // Lock: the scorer can no longer write.
  await btn(admin, 'Lock game…').click();
  await btn(admin, 'Lock game').click();
  await expect(admin.getByText('Locked', { exact: true })).toBeVisible();
  await player(scorer, 'A', 5).click();
  await btn(scorer, '2 ✓').click();
  await expect(scorer.getByText(/The server refused an event: game is locked/)).toBeVisible({ timeout: 10_000 });
  await expect(scorer.getByTestId('score-A')).toHaveText('3');

  // Admins can still correct after the lock.
  await admin.getByText('#4 Lions 4 3PT made').click();
  await btn(admin, 'Make it 2PT').click();
  await expect(admin.getByRole('heading', { name: 'Lions 2 – 2 Tigers' })).toBeVisible();

  // Season stats include the game.
  await btn(admin, '‹ Games').click();
  await btn(admin, 'Season stats').click();
  await admin.getByLabel('Season').selectOption({ label: '2026' });
  await expect(admin.getByTestId('season-players')).toContainText('Lions 4');

  // Co-admin by email: unknown account gets a clear message.
  await btn(admin, 'Admins').click();
  await admin.getByPlaceholder('colleague@example.com').fill('nobody@example.com');
  await btn(admin, 'Add admin').click();
  await expect(admin.getByText('No account uses nobody@example.com')).toBeVisible();
});
