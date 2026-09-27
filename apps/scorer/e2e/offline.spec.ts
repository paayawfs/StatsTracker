import { expect, test } from '@playwright/test';
import { btn, createGame, joinAndStart, player, serverEvents } from './fixtures';

test('offline: keep scoring, reload the page offline, then sync on reconnect', async ({ page, context }) => {
  const g = await createGame();
  // One visit only, like a real scorer: join, then lose signal. The service worker installs during
  // this visit, after the page's own assets have already loaded.
  await joinAndStart(page, g.code);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    while (!navigator.serviceWorker.controller) await new Promise((r) => setTimeout(r, 50));
  });
  await expect(page.getByText('online')).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByText('offline')).toBeVisible({ timeout: 15_000 });

  // Score while offline.
  await player(page, 'A', 4).click();
  await btn(page, '3 ✓').click();
  await btn(page, 'Skip').click();
  await player(page, 'B', 5).click();
  await btn(page, '2 ✓').click();
  await btn(page, 'Skip').click();
  await expect(page.getByTestId('score-A')).toHaveText('3');
  await expect(page.getByText(/2 to sync/)).toBeVisible();

  // Reload with no network: the service worker serves the app, IndexedDB restores the game.
  await page.reload();
  await expect(page.getByTestId('score-A')).toHaveText('3');
  await expect(page.getByTestId('score-B')).toHaveText('2');
  await expect(page.getByText(/2 to sync/)).toBeVisible();

  // Back online: the outbox drains and the server has both shots.
  await context.setOffline(false);
  await expect(page.getByText('to sync')).toHaveCount(0, { timeout: 20_000 });
  const shots = (await serverEvents(g.slug)).filter((e) => e.type === 'shot');
  expect(shots).toHaveLength(2);
});
