import { expect, test } from '@playwright/test';
import { btn, createGame, device, pickStartersAndStart, player, serverEvents, menu } from './fixtures';

test('three devices: clock device runs the game, split rebound and free-throw prompts, peer latency', async ({ browser }) => {
  const g = await createGame(false, 'multi');
  const a = await device(browser, g.code, 'teamA');
  const b = await device(browser, g.code, 'teamB');
  const c = await device(browser, g.code, 'clock');

  // Only the clock device may start the game; the others wait.
  await expect(a.page.getByText('Waiting for the game to start')).toBeVisible();
  await pickStartersAndStart(c.page);
  for (const d of [a, b]) await expect(d.page.getByTestId('clock')).toHaveText('10:00');

  // Clock device starts the clock; team devices can't.
  await c.page.getByTestId('clock').click();
  await expect(a.page.getByTestId('clock')).toHaveClass(/running/);

  // A misses: A's device offers only offensive/team-A rebound; B's device is prompted for the defensive one.
  await player(a.page, 'A', 4).click();
  await btn(a.page, '2 ✗').click();
  await expect(b.page.getByText('Rebound? Tap the player or Team REB.')).toBeVisible();
  await player(b.page, 'B', 5).click();
  await expect(a.page.getByText('Rebound? Tap the player or Team REB.')).toHaveCount(0); // cleared by B's rebound

  // B's shooting foul on A #6: B records the foul, A's device gets the free throws.
  await player(b.page, 'B', 6).click();
  await btn(b.page, 'FOUL').click();
  await btn(b.page, 'shooting').click();
  await player(b.page, 'A', 6).click();
  await btn(b.page, '2').click();
  await expect(b.page.getByText('scored on the Lions phone')).toBeVisible();
  await a.page.getByTestId('ft-made').click();
  await a.page.waitForTimeout(400); // the second free throw, not a double tap
  await a.page.getByTestId('ft-made').click();
  for (const d of [a, b, c]) await expect(d.page.getByTestId('score-A')).toHaveText('2');

  // A device selecting an opponent only gets the secondary actions.
  await player(a.page, 'B', 4).click();
  await expect(btn(a.page, '2 ✓')).toBeDisabled(); // opponent selected: no primary actions here
  await expect(btn(a.page, 'BLK')).toBeVisible();
  await btn(a.page, 'Cancel').click();

  // Timeouts live on the control device only.
  await expect(a.page.getByRole('button', { name: /^Timeout/ })).toHaveCount(0);
  await c.page.getByRole('button', { name: 'Timeout Tigers' }).click();

  // B scores; the tap reaches the other devices well inside 300 ms (local stack).
  await player(b.page, 'B', 7).click();
  await btn(b.page, '3 ✓').click();
  await btn(b.page, 'Skip').click();
  for (const d of [a, c]) await expect(d.page.getByTestId('score-B')).toHaveText('3');
  const samples = await a.page.evaluate(() => (window as unknown as { __scorer: { peerLatency: { value: number[] } } }).__scorer.peerLatency.value);
  console.log(`peer fast-path latency (local): ${samples.map(Math.round).join(', ')} ms`);
  expect(samples.length).toBeGreaterThan(0);
  expect(Math.max(...samples)).toBeLessThan(300);

  // Everything is durable and nothing was refused.
  for (const d of [a, b, c]) await expect(d.page.getByText('to sync')).toHaveCount(0, { timeout: 10_000 });
  const types = (await serverEvents(g.slug)).map((e) => e.type);
  expect(types.filter((t) => t === 'roleClaim')).toHaveLength(3);
  expect(types).toEqual(expect.arrayContaining(['shot', 'rebound', 'foul', 'freeThrow', 'timeout', 'clockStart']));
  for (const d of [a, b, c]) await expect(d.page.getByText(/refused/)).toHaveCount(0);
});

test('a second claim on a held role is refused', async ({ browser }) => {
  const g = await createGame(false, 'multi');
  const a = await device(browser, g.code, 'teamA');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByLabel('Game code').fill(g.code);
  await page.getByRole('button', { name: 'Join game' }).click();
  await expect(page.getByTestId('role-teamA')).toContainText('another device');
  await expect(page.getByTestId('role-teamA').getByRole('button', { name: 'Claim' })).toHaveCount(0);
  await expect(a.page.getByText('Confirm starters')).toBeVisible(); // A holds control (no clock role)
});

test('a dead device: another device takes over its role at a stoppage', async ({ browser }) => {
  const g = await createGame(false, 'multi');
  const a = await device(browser, g.code, 'teamA');
  const b = await device(browser, g.code, 'teamB');
  await pickStartersAndStart(a.page); // no clock role: team A controls the game
  await player(a.page, 'A', 4).click();
  await btn(a.page, '2 ✓').click();
  await btn(a.page, 'Skip').click();
  await expect(b.page.getByTestId('score-A')).toHaveText('2');

  await a.context.close(); // A's phone dies

  // B takes over team A and becomes the only device (multi -> single fallback).
  await menu(b.page, 'Roles');
  await b.page.getByTestId('role-teamA').getByRole('button', { name: 'Take over' }).click();
  await expect(b.page.getByTestId('role-teamA')).toContainText('you');
  await btn(b.page, 'Close').click();

  await player(b.page, 'A', 5).click();
  await btn(b.page, '3 ✓').click();
  await btn(b.page, 'Skip').click();
  await b.page.getByTestId('clock').click(); // B now controls the game clock too
  await expect(b.page.getByTestId('clock')).toHaveClass(/running/);
  await expect(b.page.getByTestId('score-A')).toHaveText('5');
  await expect(b.page.getByText('to sync')).toHaveCount(0, { timeout: 10_000 });
  await expect(b.page.getByText(/refused/)).toHaveCount(0);
  expect((await serverEvents(g.slug)).filter((e) => e.type === 'shot')).toHaveLength(2);
});

test('concurrent amendments: both scorers are told, last write wins everywhere', async ({ browser }) => {
  const g = await createGame(false, 'multi');
  const a = await device(browser, g.code, 'teamA');
  const b = await device(browser, g.code, 'teamB');
  await pickStartersAndStart(a.page);
  await player(a.page, 'A', 4).click();
  await btn(a.page, '2 ✓').click();
  await btn(a.page, 'Skip').click();
  await expect(b.page.getByTestId('score-A')).toHaveText('2');

  // Both open the play-by-play and correct the same shot differently at the same time.
  for (const d of [a, b]) {
    await menu(d.page, 'Play-by-play');
    await d.page.getByTestId('pbp').getByText('2PT made').click();
  }
  await Promise.all([btn(a.page, 'Make it 3PT').click(), btn(b.page, 'Mark missed').click()]);

  for (const d of [a, b]) await expect(d.page.getByText('Another scorer changed an event you corrected')).toBeVisible();
  await expect(a.page.getByText('to sync')).toHaveCount(0, { timeout: 10_000 });
  await expect(b.page.getByText('to sync')).toHaveCount(0, { timeout: 10_000 });
  const scoreA = await a.page.getByTestId('score-A').textContent();
  await expect(b.page.getByTestId('score-A')).toHaveText(scoreA!);
  expect(['0', '3']).toContain(scoreA);
});

test('offline device keeps scoring and merges on reconnect', async ({ browser }) => {
  const g = await createGame(false, 'multi');
  const a = await device(browser, g.code, 'teamA');
  const b = await device(browser, g.code, 'teamB');
  await pickStartersAndStart(a.page);

  await b.context.setOffline(true);
  await expect(b.page.getByText('offline')).toBeVisible({ timeout: 15_000 });
  await player(b.page, 'B', 4).click();
  await btn(b.page, '3 ✓').click();
  await btn(b.page, 'Skip').click();
  await player(a.page, 'A', 4).click();
  await btn(a.page, '2 ✓').click();
  await btn(a.page, 'Skip').click();
  await expect(a.page.getByTestId('score-B')).toHaveText('0'); // A can't see B's offline shot yet

  await b.context.setOffline(false);
  for (const d of [a, b]) {
    await expect(d.page.getByTestId('score-A')).toHaveText('2', { timeout: 20_000 });
    await expect(d.page.getByTestId('score-B')).toHaveText('3', { timeout: 20_000 });
    await expect(d.page.getByText('to sync')).toHaveCount(0, { timeout: 20_000 });
  }
});
