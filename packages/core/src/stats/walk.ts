import type { GameEvent } from '../events';
import { apply, initialState, type GameState } from '../reducer';

export interface Step {
  event: GameEvent;
  before: GameState;
  after: GameState;
  /** Game time (ms) since the previous event in the same period, played by `before.onFloor`. */
  elapsed: number;
}

/**
 * Replay an effective, canonically ordered log (e.g. `GameLog.events`), yielding each event with
 * the state around it. All derived stats are folds over this.
 */
/** Bookkeeping, not play: their clock (e.g. 0 on an admin correction) says nothing about game time. */
const NO_TIME = new Set(['amend', 'void', 'adminLock', 'checkpoint', 'roleClaim', 'roleRelease', 'roleTransfer']);

export function* walk(events: readonly GameEvent[]): Generator<Step> {
  let state = initialState;
  let period = -1;
  let clock = 0;
  for (const event of events) {
    const before = state;
    const after = apply(before, event);
    if (NO_TIME.has(event.type)) {
      state = after;
      yield { event, before, after, elapsed: 0 };
      continue;
    }
    const elapsed = event.type !== 'periodStart' && event.period === period && event.period > 0 ? Math.max(0, clock - event.gameClock) : 0;
    if (event.period > 0 || event.type === 'periodStart') {
      period = event.period;
      clock = event.type === 'periodStart' ? after.clock.gameClock : event.gameClock;
    }
    state = after;
    yield { event, before, after, elapsed };
  }
}
