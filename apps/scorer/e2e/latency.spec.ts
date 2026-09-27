import { expect, test } from '@playwright/test';
import { btn, createGame, joinAndStart, player } from './fixtures';

// Brief: tap to the scorer's own screen under 50 ms, checked on a throttled CPU.
test('tap-to-render stays under 50 ms with the CPU throttled 4x', async ({ page }) => {
  const g = await createGame();
  await joinAndStart(page, g.code);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.evaluate(() => ((window as unknown as { __scorer: { tapToRender: { value: number[] } } }).__scorer.tapToRender.value = []));

  for (let i = 0; i < 15; i++) {
    await player(page, i % 2 ? 'B' : 'A', 4 + (i % 5)).click();
    await btn(page, i % 3 ? '2 ✗' : '2 ✓').click();
    await btn(page, 'Skip').click();
  }
  await page.waitForTimeout(300);

  const samples = await page.evaluate(() => (window as unknown as { __scorer: { tapToRender: { value: number[] } } }).__scorer.tapToRender.value);
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  console.log(`tap-to-render @4x CPU: n=${sorted.length} median=${sorted[sorted.length >> 1]!.toFixed(1)} p95=${p95.toFixed(1)} max=${sorted.at(-1)!.toFixed(1)} ms`);
  expect(sorted.length).toBeGreaterThanOrEqual(45);
  expect(p95).toBeLessThan(50);
});
