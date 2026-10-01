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
  // A photo for Lions #4 (a tiny PNG), shrunk in the browser and stored with the player.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await admin.getByLabel('Photo for Lions 4').setInputFiles({ name: 'lions4.png', mimeType: 'image/png', buffer: png });
  await expect(admin.getByTestId('team-Lions').locator('img.avatar')).toHaveCount(1);

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
  // Starter cards show the photo, or initials when there is none.
  await expect(scorer.getByTestId('starter-4-A').locator('img.avatar')).toBeVisible();
  await expect(scorer.getByTestId('starter-5-A')).toContainText('L5');
  await expect(scorer.getByTestId('starter-5-A')).toContainText('Lions 5');
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
  // The score follows the game without a reload.
  await player(scorer, 'B', 6).click();
  await btn(scorer, '2 ✓').click();
  await btn(scorer, 'Skip').click();
  await expect(admin.getByRole('heading', { name: 'Lions 3 – 4 Tigers' })).toBeVisible({ timeout: 10_000 });

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
  await expect(admin.getByRole('heading', { name: 'Lions 2 – 4 Tigers' })).toBeVisible();

  // Unlock: scorers can write again.
  await btn(admin, 'Unlock game…').click();
  await btn(admin, 'Unlock game').click();
  await expect(admin.getByText('Locked', { exact: true })).toHaveCount(0);
  await player(scorer, 'A', 6).click();
  await btn(scorer, '2 ✓').click();
  await btn(scorer, 'Skip').click();
  await expect(scorer.getByTestId('score-A')).toHaveText('4');
  await expect(scorer.getByText('to sync')).toHaveCount(0, { timeout: 10_000 });

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

test('admin: import a roster CSV, map the columns, preview, import', async ({ browser }) => {
  const admin = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await admin.goto('/admin');
  await admin.getByLabel('Email').fill(`csv-${Date.now()}@example.com`);
  await admin.getByLabel('Password').fill('correct-horse-battery');
  await btn(admin, 'Create account').click();
  await admin.getByPlaceholder('League name').fill('CSV League');
  await btn(admin, 'Create league').click();
  await admin.getByRole('button', { name: 'CSV League' }).click();
  await btn(admin, 'Teams & players').click();
  await admin.getByPlaceholder('Team name').fill('Lions');
  await btn(admin, 'Add team').click();
  await admin.getByTestId('team-Lions').getByRole('textbox').fill('23 Kofi Mensah');
  await admin.getByTestId('team-Lions').getByRole('button', { name: 'Add 1 player' }).click();
  await expect(admin.getByTestId('team-Lions').getByText('1 player', { exact: true })).toBeVisible();

  const csv = ['Player,No.,Club', 'Kofi Mensah,23,Lions', 'Ama Ofori,7,Tigers', '"Boateng, Yaw",4,lions', ',9,Tigers', 'Esi Quaye,7,Tigers'].join('\r\n');
  await admin.getByText('Import players from a CSV file').click();
  await admin.getByLabel('CSV file').setInputFiles({ name: 'roster.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });

  // Guessed mapping, and the preview explains every row.
  await expect(admin.getByLabel('Full name')).toHaveValue('0');
  await expect(admin.getByLabel('Jersey')).toHaveValue('1');
  await expect(admin.getByLabel('Team', { exact: true })).toHaveValue('2');
  await expect(admin.getByTestId('csv-summary')).toHaveText('2 to add · 1 skipped · 2 with problems · new teams: Tigers');
  await expect(admin.getByText('already on Lions')).toBeVisible();
  await expect(admin.getByText('no name')).toBeVisible();
  await expect(admin.getByText('jersey 7 is already used on Tigers in this file')).toBeVisible();

  // Remapping: with no team column, everyone goes to a chosen team.
  await admin.getByLabel('Team', { exact: true }).selectOption('');
  await expect(admin.getByLabel('Add everyone to')).toBeVisible();
  await admin.getByLabel('Team', { exact: true }).selectOption('2');

  await btn(admin, 'Import 2 players').click();
  await expect(admin.getByText('Added 2 players and 1 new team.')).toBeVisible();
  await expect(admin.getByTestId('team-Lions').getByText('2 players')).toBeVisible();
  await expect(admin.getByTestId('team-Tigers').getByText('1 player', { exact: true })).toBeVisible();
  await expect(admin.getByTestId('team-Lions').getByText('Boateng, Yaw')).toBeVisible();
});

test('admin: rename a team, edit and delete players, delete a season', async ({ browser }) => {
  const admin = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await admin.goto('/admin');
  await admin.getByLabel('Email').fill(`edit-${Date.now()}@example.com`);
  await admin.getByLabel('Password').fill('correct-horse-battery');
  await btn(admin, 'Create account').click();
  await admin.getByPlaceholder('League name').fill('Edit League');
  await btn(admin, 'Create league').click();
  await admin.getByRole('button', { name: 'Edit League' }).click();

  await btn(admin, 'Teams & players').click();
  await admin.getByPlaceholder('Team name').fill('Lions');
  await btn(admin, 'Add team').click();
  const card = admin.getByTestId('team-Lions');
  await card.getByRole('textbox').fill('4 Kofi Mensah\n5 Ama Ofori');
  await card.getByRole('button', { name: 'Add 2 players' }).click();

  // Rename the team (a duplicate name is refused first).
  await admin.getByPlaceholder('Team name').fill('Tigers');
  await btn(admin, 'Add team').click();
  await admin.getByRole('button', { name: 'Edit team Lions' }).click();
  await admin.getByLabel('team name').fill('tigers');
  await btn(admin, 'Save').click();
  await expect(admin.getByText('There is already a team called tigers.')).toBeVisible();
  await admin.getByLabel('team name').fill('Accra Lions');
  await btn(admin, 'Save').click();
  const renamed = admin.getByTestId('team-Accra Lions');
  await expect(renamed).toBeVisible();

  // Edit a player's name and jersey; then delete the other.
  await renamed.getByRole('button', { name: 'Edit player Kofi Mensah' }).click();
  await renamed.getByLabel('Jersey').fill('23');
  await renamed.getByLabel('player name').fill('Kofi Mensah Jr');
  await btn(admin, 'Save').click();
  await expect(renamed.getByText('Kofi Mensah Jr')).toBeVisible();
  await expect(renamed.getByText('23', { exact: true })).toBeVisible();
  await renamed.getByRole('button', { name: 'Edit player Ama Ofori' }).click();
  await btn(admin, 'Delete…').click();
  await btn(admin, 'Yes, delete Ama Ofori').click();
  await expect(renamed.getByText('Ama Ofori')).toHaveCount(0);
  await expect(renamed.getByText('1 player', { exact: true })).toBeVisible();

  // Seasons: add, then delete.
  await btn(admin, 'Seasons').click();
  await admin.getByPlaceholder('Season name, e.g. 2026/27').fill('2025');
  await btn(admin, 'Add season').click();
  await admin.getByRole('button', { name: 'Edit season 2025' }).click();
  await btn(admin, 'Delete…').click();
  await btn(admin, 'Yes, delete 2025').click();
  await expect(admin.getByText('2025')).toHaveCount(0);
});
