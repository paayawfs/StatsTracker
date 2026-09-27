import { expect, test } from '@playwright/test';
import { btn, createGame, joinAndStart, player } from './fixtures';

const SHOTS = 'C:/Users/PAAYAW~1/AppData/Local/Temp/claude/C--Users-Paa-Yaw-Downloads-Stats/0f4142bf-8a0c-49b0-ba93-a6087dc6c37d/scratchpad';

test.use({ viewport: { width: 568, height: 320 }, hasTouch: true, isMobile: true });

test('iPhone SE landscape: a shot at the rim can be tapped, and the whole menu is on screen', async ({ page }) => {
  const g = await createGame(true);
  await joinAndStart(page, g.code);
  await player(page, 'A', 4).click();
  const court = page.getByTestId('court');
  const box = (await court.boundingBox())!;
  // Just above the rim (the restricted area), where the "No spot" bar used to sit.
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * (116 / 140));
  await expect(page.getByText('Restricted area')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/se-rim.png` });
  await btn(page, '2 Made').click();
  await expect(page.getByTestId('score-A')).toHaveText('2');
  await btn(page, 'Skip').click();

  await page.getByRole('button', { name: 'More' }).click();
  for (const item of ['Play-by-play', 'Leave game']) {
    const b = page.getByRole('button', { name: item, exact: true });
    await b.scrollIntoViewIfNeeded();
    const r = (await b.boundingBox())!;
    expect(r.y, item).toBeGreaterThanOrEqual(0);
    expect(r.y + r.height, item).toBeLessThanOrEqual(320);
  }
  await page.screenshot({ path: `${SHOTS}/se-menu.png` });
});
