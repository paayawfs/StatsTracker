import { expect, test } from '@playwright/test';
import { btn, createGame, joinAndStart, player } from '../../scorer/e2e/fixtures';

const SCORER = 'http://localhost:4173';
const VIEWER = 'http://localhost:4174';
const SHOTS = 'C:/Users/PAAYAW~1/AppData/Local/Temp/claude/C--Users-Paa-Yaw-Downloads-Stats/0f4142bf-8a0c-49b0-ba93-a6087dc6c37d/scratchpad';

test('phones: no tab is wider than the screen, and the box score shows its stats', async ({ browser }) => {
  const g = await createGame(true);
  const scorer = await (await browser.newContext({ baseURL: SCORER, viewport: { width: 1180, height: 820 } })).newPage();
  await joinAndStart(scorer, g.code);
  await scorer.getByTestId('clock').click();
  await player(scorer, 'A', 4).click();
  const court = scorer.getByTestId('court');
  const box = (await court.boundingBox())!;
  await court.click({ position: { x: box.width * 0.5, y: box.height * 0.1 } });
  await btn(scorer, '3 Made').click();
  await btn(scorer, 'Skip').click();

  for (const width of [320, 390]) {
    const viewer = await (await browser.newContext({ viewport: { width, height: 740 }, isMobile: true, hasTouch: true })).newPage();
    await viewer.goto(`${VIEWER}/g/${g.slug}`);
    await expect(viewer.getByTestId('score-A')).toHaveText('3');
    for (const tab of ['Box score', 'Play-by-play', 'Lineups', 'On/Off', 'Shot chart']) {
      await viewer.getByRole('button', { name: tab, exact: true }).click();
      const wide = await viewer.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(wide, `${tab} at ${width}px`).toBeLessThanOrEqual(0);
      if (width === 320) await viewer.screenshot({ path: `${SHOTS}/resp-${width}-${tab.replace(/\W/g, '')}.png` });
    }
    // The sticky name column leaves room: PTS is on screen without scrolling the table.
    await viewer.getByRole('button', { name: 'Box score', exact: true }).click();
    const pts = viewer.getByTestId('box-A').getByRole('columnheader', { name: 'PTS' });
    const r = (await pts.boundingBox())!;
    expect(r.x + r.width, `PTS visible at ${width}px`).toBeLessThanOrEqual(width);
    await viewer.context().close();
  }
});
