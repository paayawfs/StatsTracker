import { expect, test } from '@playwright/test';
import { createGame, joinAndStart, player } from './fixtures';

test('phone: live scoring fits one screen, no scrolling', async ({ page }) => {
  const g = await createGame(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await joinAndStart(page, g.code);
  await player(page, 'B', 5).click();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(844);
});
