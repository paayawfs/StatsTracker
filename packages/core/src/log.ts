import type { GameEvent } from './events';
import { apply, initialState, type GameState } from './reducer';

/** Canonical order: period asc, gameClock desc, seq asc (unconfirmed last), wallClock, id. */
export function compareEvents(a: GameEvent, b: GameEvent): number {
  return (
    a.period - b.period ||
    b.gameClock - a.gameClock ||
    (a.seq ?? Infinity) - (b.seq ?? Infinity) ||
    a.wallClock - b.wallClock ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * The event log in canonical order plus the state after each event, so a late or replaced event
 * replays only from where it lands. Appending at the end applies exactly one event.
 */
export class GameLog {
  readonly events: GameEvent[] = [];
  private readonly states: GameState[] = [];
  private readonly byId = new Map<string, GameEvent>();

  get state(): GameState {
    return this.states[this.states.length - 1] ?? initialState;
  }

  /** Returns the index replay started from, or -1 if the event changed nothing. */
  add(e: GameEvent): number {
    const prev = this.byId.get(e.id);
    // Duplicate, or a stale unconfirmed copy of an event we already have durably.
    if (prev && (prev.seq !== null || e.seq === null)) return -1;
    this.byId.set(e.id, e);
    const removedAt = prev ? this.remove(prev) : Infinity;
    const from = Math.min(removedAt, this.insert(e));
    this.replayFrom(from);
    return from;
  }

  private insert(e: GameEvent): number {
    let i = this.events.length;
    while (i > 0 && compareEvents(this.events[i - 1]!, e) > 0) i--;
    this.events.splice(i, 0, e);
    return i;
  }

  private remove(e: GameEvent): number {
    const i = this.events.indexOf(e);
    this.events.splice(i, 1);
    return i;
  }

  private replayFrom(i: number) {
    this.states.length = i;
    let s = this.states[i - 1] ?? initialState;
    for (let k = i; k < this.events.length; k++) this.states.push((s = apply(s, this.events[k]!)));
  }
}
