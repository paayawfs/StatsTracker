import { isCorrection, type EventOf, type GameEvent } from './events';
import { apply, initialState, type GameState } from './reducer';

type Correction = EventOf<'amend' | 'void'>;

const byIdOrder = (a: GameEvent, b: GameEvent) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Canonical order: period asc, gameClock desc, seq asc (unconfirmed last), wallClock, id. */
export function compareEvents(a: GameEvent, b: GameEvent): number {
  return (
    a.period - b.period ||
    b.gameClock - a.gameClock ||
    (a.seq ?? Infinity) - (b.seq ?? Infinity) ||
    a.wallClock - b.wallClock ||
    byIdOrder(a, b)
  );
}

/** Write order for last-write-wins: server seq (unconfirmed last), then wallClock, then id. */
const compareWrites = (a: GameEvent, b: GameEvent) =>
  (a.seq ?? Infinity) - (b.seq ?? Infinity) || a.wallClock - b.wallClock || byIdOrder(a, b);

/**
 * The effective event log in canonical order plus the state after each event, so a late,
 * replaced or corrected event replays only from where it lands. Appending applies one event.
 *
 * `events` holds each game event in its corrected form (amended body, or absent if voided) and
 * the correction events themselves as markers where they happened.
 */
export class GameLog {
  readonly events: GameEvent[] = [];
  private readonly states: GameState[] = [];
  private readonly byId = new Map<string, GameEvent>();
  private readonly corrections = new Map<string, Correction[]>();
  private readonly locks: GameEvent[] = [];

  get state(): GameState {
    return this.states[this.states.length - 1] ?? initialState;
  }

  /** Returns the index replay started from, or -1 if the event changed nothing. */
  add(e: GameEvent): number {
    const prev = this.byId.get(e.id);
    // Duplicate, or a stale unconfirmed copy of an event we already have durably.
    if (prev && (prev.seq !== null || e.seq === null)) return -1;
    this.byId.set(e.id, e);

    let from = Infinity;
    if (prev) {
      from = this.remove(e.id);
      if (isCorrection(prev)) this.forget(this.corrections.get(prev.payload.targetId) ?? [], prev.id);
      if (prev.type === 'adminLock') this.forget(this.locks, prev.id);
    }

    if (isCorrection(e)) {
      const list = this.corrections.get(e.payload.targetId) ?? [];
      list.push(e);
      this.corrections.set(e.payload.targetId, list);
      from = Math.min(from, this.insert(e), this.refresh(e.payload.targetId));
    } else {
      const effective = this.effective(e);
      if (effective) from = Math.min(from, this.insert(effective));
      if (e.type === 'adminLock') {
        this.locks.push(e);
        for (const target of this.corrections.keys()) from = Math.min(from, this.refresh(target));
      }
    }

    if (from === Infinity) return -1;
    this.replayFrom(from);
    return from;
  }

  /** Corrections currently in force for an event, oldest first; the last one wins. */
  correctionsFor(id: string): Correction[] {
    return (this.corrections.get(id) ?? []).filter((c) => this.applies(c)).sort(compareWrites);
  }

  /** After an admin lock, only admin corrections apply. */
  private applies(c: Correction): boolean {
    return c.role === 'admin' || !this.locks.some((l) => compareWrites(l, c) < 0);
  }

  private effective(raw: GameEvent): GameEvent | null {
    const winner = this.correctionsFor(raw.id).at(-1);
    if (!winner) return raw;
    if (winner.type === 'void') return null;
    return { ...raw, ...winner.payload.body } as GameEvent;
  }

  /** Recompute a corrected event in place. Corrections to corrections are ignored. */
  private refresh(targetId: string): number {
    const raw = this.byId.get(targetId);
    if (!raw || isCorrection(raw)) return Infinity;
    const removedAt = this.remove(targetId);
    const effective = this.effective(raw);
    return Math.min(removedAt, effective ? this.insert(effective) : Infinity);
  }

  private insert(e: GameEvent): number {
    let i = this.events.length;
    while (i > 0 && compareEvents(this.events[i - 1]!, e) > 0) i--;
    this.events.splice(i, 0, e);
    return i;
  }

  /** Remove by id. Returns the index it was at, or Infinity if absent. */
  private remove(id: string): number {
    const i = this.events.findIndex((e) => e.id === id);
    if (i < 0) return Infinity;
    this.events.splice(i, 1);
    return i;
  }

  private forget(list: GameEvent[], id: string) {
    const i = list.findIndex((e) => e.id === id);
    if (i >= 0) list.splice(i, 1);
  }

  private replayFrom(i: number) {
    this.states.length = i;
    let s = this.states[i - 1] ?? initialState;
    for (let k = i; k < this.events.length; k++) this.states.push((s = apply(s, this.events[k]!)));
  }
}
