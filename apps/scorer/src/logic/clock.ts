import type { GameState } from '@stats/core';

/** Game time remaining (ms) at server-corrected time `now`. */
export function remaining(clock: GameState['clock'], now: number): number {
  return clock.running ? Math.max(0, clock.gameClock - (now - clock.wallClock)) : clock.gameClock;
}

/** 10:00, 1:01, then tenths in the last minute: 59.9 ... 0.0 */
export function formatClock(ms: number): string {
  if (ms >= 60_000) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  const tenths = Math.floor(ms / 100);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}
