import { expect, test } from '@playwright/test';
import { btn, createGame, joinAndStart, player } from '../../scorer/e2e/fixtures';

const SCORER = 'http://localhost:4173';
const VIEWER = 'http://localhost:4174';

test('a viewer follows a live game: score within 2 s, box score, play-by-play, shot chart', async ({ browser }) => {
  const g = await createGame(true);
  const scorer = await (await browser.newContext({ baseURL: SCORER, viewport: { width: 1180, height: 820 } })).newPage();
  await joinAndStart(scorer, g.code);

  const viewer = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await viewer.goto(`${VIEWER}/g/${g.slug}`);
  await expect(viewer.getByText('● LIVE')).toBeVisible();
  await expect(viewer.getByTestId('score-A')).toHaveText('0');

  // Scorer: #4 shoots from above the break (court tap), made 3.
  await player(scorer, 'A', 4).click();
  const court = scorer.getByTestId('court');
  const box = (await court.boundingBox())!;
  await court.click({ position: { x: box.width * 0.5, y: box.height * 0.1 } });
  const t0 = Date.now();
  await btn(scorer, '3 Made').click(); // the card shows the value: '3 Made'
  await expect(viewer.getByTestId('score-A')).toHaveText('3');
  const ms = Date.now() - t0;
  console.log(`tap -> viewer (local): ${ms} ms`);
  expect(ms).toBeLessThan(2000);
  await btn(scorer, 'Skip').click();

  // B misses a 2, A rebounds.
  await player(scorer, 'B', 5).click();
  await btn(scorer, '2 ✗').click();
  await player(scorer, 'A', 6).click();

  // Box score row for A #4.
  const row = viewer.getByTestId('box-A').locator('tr', { hasText: 'Lion 4' });
  await expect(row).toContainText('3'); // PTS
  await expect(row.locator('td').nth(4)).toHaveText('1-1'); // 3P
  await expect(viewer.getByTestId('box-A').locator('tr', { hasText: 'Lion 6' }).locator('td').nth(8)).toHaveText('1'); // REB

  await viewer.getByRole('button', { name: 'Play-by-play' }).click();
  await expect(viewer.getByTestId('plays')).toContainText('#4 Lion 4 3PT made');
  await expect(viewer.getByTestId('plays')).toContainText('#6 Lion 6 defensive rebound');

  await viewer.getByRole('button', { name: 'Shot chart' }).click();
  await expect(viewer.getByTestId('shot-chart').locator('circle.made')).toHaveCount(1);

  await viewer.getByRole('button', { name: 'Lineups' }).click();
  await expect(viewer.getByText('Lions lineups')).toBeVisible();

  // A late viewer gets the whole history.
  const late = await (await browser.newContext()).newPage();
  await late.goto(`${VIEWER}/g/${g.slug}`);
  await expect(late.getByTestId('score-A')).toHaveText('3');
  await expect(late.getByTestId('box-B').locator('tr', { hasText: 'Tiger 5' }).locator('td').nth(3)).toHaveText('0-1'); // FG
});

test('an unknown link shows "not found"', async ({ page }) => {
  await page.goto(`${VIEWER}/g/${'0'.repeat(32)}`);
  await expect(page.getByText('Game not found')).toBeVisible();
});
