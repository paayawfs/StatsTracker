import { expect, test, type Page } from '@playwright/test';
import { btn, createGame, device, joinAndStart, pickStartersAndStart, player, menu } from './fixtures';

// Scorers hold phones in landscape. Every in-play screen must fit without scrolling.
const PHONES = [
  { name: 'iPhone 844x390', width: 844, height: 390 },
  { name: 'small Android 740x360', width: 740, height: 360 },
];

async function fits(page: Page, what: string) {
  const { sh, sw, h, w } = await page.evaluate(() => ({
    sh: document.documentElement.scrollHeight,
    sw: document.documentElement.scrollWidth,
    h: window.innerHeight,
    w: window.innerWidth,
  }));
  expect(sh, `${what}: page is ${sh}px tall in a ${h}px screen`).toBeLessThanOrEqual(h);
  expect(sw, `${what}: page is ${sw}px wide in a ${w}px screen`).toBeLessThanOrEqual(w);
}

for (const phone of PHONES) {
  test(`landscape ${phone.name}: every in-play screen fits without scrolling`, async ({ page }) => {
    const g = await createGame(true);
    await page.setViewportSize({ width: phone.width, height: phone.height });
    await joinAndStart(page, g.code);
    await fits(page, 'idle');

    await player(page, 'A', 4).click();
    await fits(page, 'player selected (shot buttons + court + actions)');
    await expect(page.getByTestId('court')).toBeInViewport();
    await expect(btn(page, 'SUB')).toBeInViewport();

    await btn(page, 'TO').click();
    await fits(page, 'turnover type picker');
    await btn(page, 'Bad pass').click();
    await btn(page, 'Skip').click();

    await player(page, 'B', 5).click();
    await btn(page, 'FOUL').click();
    await fits(page, 'foul type picker');
    await btn(page, 'shooting').click();
    await player(page, 'A', 4).click();
    await btn(page, '2').click();
    await fits(page, 'free-throw bar');
    await expect(page.getByTestId('ft-made')).toBeInViewport();
    await page.getByTestId('ft-made').click();
    await page.waitForTimeout(400); // the second free throw, not a double tap
    await page.getByTestId('ft-made').click();

    await player(page, 'A', 8).click();
    await btn(page, 'SUB').click();
    await fits(page, 'substitution (whole roster)');
    await expect(player(page, 'A', 15)).toBeInViewport();
    await player(page, 'A', 15).click();
    await btn(page, 'Confirm').click();

    await expect(page.getByTestId('undo')).toBeInViewport();
    await menu(page, 'Play-by-play');
    await fits(page, 'play-by-play open');
  });
}

test('landscape small Android: the game-control device (control bar) fits too', async ({ browser }) => {
  const g = await createGame(false, 'multi');
  const a = await device(browser, g.code, 'teamA');
  await a.page.setViewportSize({ width: 740, height: 360 });
  await pickStartersAndStart(a.page);
  await expect(a.page.getByRole('button', { name: 'Timeout Lions' })).toBeInViewport();
  await player(a.page, 'A', 4).click();
  await fits(a.page, 'control device, player selected');
});
