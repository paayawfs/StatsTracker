import { expect, test } from '@playwright/test';
import { createGame, joinAndStart, player } from './fixtures';

test('laptop: a sequence entered entirely from the keyboard', async ({ page }) => {
  const g = await createGame();
  await joinAndStart(page, g.code);
  const kb = page.keyboard;
  const scoreA = page.getByTestId('score-A');
  const scoreB = page.getByTestId('score-B');

  await kb.press('Space');
  await expect(page.getByTestId('clock')).toHaveClass(/running/);

  // #4 (team A preferred) made 2, assist #5 typed with Enter.
  await kb.type('4');
  await expect(player(page, 'A', 4)).toHaveClass(/\bon\b/);
  await kb.press('s');
  await kb.type('5');
  await kb.press('Enter');
  await expect(scoreA).toHaveText('2');

  // Both teams have #4: Tab moves the selection to team B. Made 3, skip assist.
  await kb.type('4');
  await kb.press('Enter');
  await kb.press('Tab');
  await expect(player(page, 'B', 4)).toHaveClass(/\bon\b/);
  await kb.press('d');
  await kb.press('Escape');
  await expect(scoreB).toHaveText('3');

  // B #6 shooting foul on A #7 (the prompt prefers the other team), 2 FTs, both made.
  await kb.type('6');
  await kb.press('Enter');
  await kb.press('f');
  await kb.press('s');
  await kb.type('7');
  await kb.press('Enter');
  await kb.press('2');
  await kb.press('m');
  await kb.press('m');
  await expect(scoreA).toHaveText('4');

  // Undo the last free throw.
  await kb.press('z');
  await expect(scoreA).toHaveText('3');

  // Help overlay.
  await kb.press('?');
  await expect(page.getByText('Keyboard')).toBeVisible();
  await kb.press('?');
  await expect(page.getByText('Keyboard')).toHaveCount(0);
});
