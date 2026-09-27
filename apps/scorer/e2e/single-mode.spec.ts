import { expect, test } from '@playwright/test';
import { NBA } from '../../../packages/core/src/rules';
import { btn, createGame, joinAndStart, joinCode, player, serverEvents, menu } from './fixtures';

test('a full single-mode sequence: shots, assist, rebound, foul + free throws, sub, undo, period end', async ({ page }) => {
  const g = await createGame();
  await joinAndStart(page, g.code);
  const scoreA = page.getByTestId('score-A');
  const scoreB = page.getByTestId('score-B');

  await page.getByTestId('clock').click(); // start the clock

  // Made 2 with an assist (two taps + one prompt tap).
  await player(page, 'A', 4).click();
  await btn(page, '2 ✓').click();
  await expect(page.getByText('Assist? Tap the passer.')).toBeVisible();
  await player(page, 'A', 5).click();
  await expect(scoreA).toHaveText('2');

  // Missed 3, defensive rebound from the prompt.
  await player(page, 'B', 4).click();
  await btn(page, '3 ✗').click();
  await player(page, 'A', 7).click();

  // Shooting foul, two free throws for the fouled player, both made.
  await player(page, 'B', 5).click();
  await btn(page, 'FOUL').click();
  await btn(page, 'shooting').click();
  await player(page, 'A', 4).click();
  await btn(page, '2').click();
  await page.getByTestId('ft-made').click();
  await page.getByTestId('ft-made').click();
  await expect(scoreA).toHaveText('4');

  // Made 3 for B, skip the assist.
  await player(page, 'B', 6).click();
  await btn(page, '3 ✓').click();
  await btn(page, 'Skip').click();
  await expect(scoreB).toHaveText('3');

  // Substitution: A #8 out, #9 in.
  await player(page, 'A', 8).click();
  await btn(page, 'SUB').click();
  await player(page, 'A', 9).click();
  await btn(page, 'Confirm').click();
  await expect(player(page, 'A', 9)).toBeVisible();
  await expect(player(page, 'A', 8)).toHaveCount(0);

  // Undo the substitution.
  await page.getByTestId('undo').click();
  await expect(player(page, 'A', 8)).toBeVisible();
  await expect(player(page, 'A', 9)).toHaveCount(0);

  // End the period and reconcile against the scoreboard.
  await menu(page, 'End period');
  await expect(page.getByText('End of period 1')).toBeVisible();
  await btn(page, 'Confirm score').click();
  await btn(page, 'Start period 2').click();
  await expect(page.getByTestId('clock')).toHaveText('10:00');

  // Everything reached the server.
  await expect(page.getByText('to sync')).toHaveCount(0, { timeout: 10_000 });
  const types = (await serverEvents(g.slug)).map((e) => e.type);
  expect(types).toEqual(
    expect.arrayContaining(['roleClaim', 'gameStart', 'periodStart', 'shot', 'amend', 'rebound', 'foul', 'freeThrow', 'substitution', 'void', 'periodEnd', 'checkpoint']),
  );
});

test('corrections from the play-by-play', async ({ page }) => {
  const g = await createGame();
  await joinAndStart(page, g.code);
  await player(page, 'A', 4).click();
  await btn(page, '2 ✓').click();
  await btn(page, 'Skip').click();
  await expect(page.getByTestId('score-A')).toHaveText('2');

  await menu(page, 'Play-by-play');
  await page.getByTestId('pbp').getByText('2PT made').click();
  await btn(page, 'Make it 3PT').click();
  await expect(page.getByTestId('score-A')).toHaveText('3');

  await page.getByTestId('pbp').getByText('3PT made').click();
  await btn(page, 'Remove').click();
  await expect(page.getByTestId('score-A')).toHaveText('0');
});

test('changing your mind: tapping another section before Made/Missed moves the shot', async ({ page }) => {
  const g = await createGame(true);
  await joinAndStart(page, g.code);
  await player(page, 'A', 4).click();
  const court = page.getByTestId('court');
  const box = (await court.boundingBox())!;
  await court.click({ position: { x: box.width * 0.5, y: box.height * 0.1 } }); // top 3
  await expect(page.getByText('Top of key 3')).toBeVisible();
  await court.click({ position: { x: box.width * 0.5, y: box.height * 0.85 } }); // near the rim instead
  await expect(page.getByText('Restricted area')).toBeVisible();
  await btn(page, '2 Made').click();
  await expect(page.getByTestId('score-A')).toHaveText('2');
  await expect.poll(async () => (await serverEvents(g.slug)).filter((e) => e.type === 'shot').map((e) => e.payload.value)).toEqual([2]);
});

test('technical foul free throw: pick the shooter first, then Made works', async ({ page }) => {
  const g = await createGame();
  await joinAndStart(page, g.code);
  await btn(page, 'Coach T').first().click(); // Lions coach technical -> 1 FT for the Tigers
  const made = page.getByTestId('ft-made');
  await expect(page.getByText('FT 1/1: tap the Tigers shooter')).toBeVisible();
  await expect(made).toBeDisabled();
  await player(page, 'B', 7).click();
  await expect(page.getByText('FT 1/1 · #7 Tiger 7')).toBeVisible();
  await expect(made).toBeEnabled();
  await made.click();
  await expect(page.getByTestId('score-B')).toHaveText('1');
  await expect(made).toHaveCount(0); // no more free throws owed
});

test('possession arrow: shown for FIBA rules, hidden when the rule set turns it off', async ({ page }) => {
  const fiba = await createGame();
  await joinAndStart(page, fiba.code);
  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByTestId('arrow')).toBeVisible();
  await page.keyboard.press('Escape');

  const nba = await createGame(false, 'single', NBA);
  await page.evaluate(() => localStorage.removeItem('scorer.game'));
  await joinAndStart(page, nba.code);
  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('button', { name: 'Jump won Lions' })).toBeVisible();
  await expect(page.getByTestId('arrow')).toHaveCount(0);
});

test('leave game: back to the join screen, rejoining picks up where it was', async ({ page }) => {
  const g = await createGame();
  await joinAndStart(page, g.code);
  await player(page, 'A', 4).click();
  await btn(page, '2 ✓').click();
  await btn(page, 'Skip').click();
  await expect(page.getByTestId('score-A')).toHaveText('2');
  await menu(page, 'Leave game');
  await expect(page.getByLabel('Game code')).toBeVisible();
  await page.getByLabel('Game code').fill(g.code);
  await page.getByRole('button', { name: 'Join game' }).click();
  await expect(page.getByTestId('score-A')).toHaveText('2');
});

test('a replacement phone takes over scoring from one that died', async ({ page, browser }) => {
  const g = await createGame();
  await joinAndStart(page, g.code);
  await player(page, 'A', 4).click();
  await btn(page, '2 ✓').click();
  await btn(page, 'Skip').click();

  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
  const spare = await context.newPage();
  await joinCode(spare, g.code);
  await spare.getByTestId('take-over-scoring').click();
  await expect(spare.getByTestId('score-A')).toHaveText('2');
  await player(spare, 'B', 4).click();
  await btn(spare, '3 ✓').click();
  await btn(spare, 'Skip').click();
  await expect.poll(async () => (await serverEvents(g.slug)).filter((e) => e.type === 'shot').length).toBe(2);
  await context.close();
});
