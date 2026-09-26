import { GameLog, isCorrection, parseEvent, type EventOf, type GameEvent } from '@stats/core';
import type { LocalStore, StoredEvent } from './store';
import { NetworkError, Rejected, type SyncTransport } from './transport';

type Timer = (fn: () => void, ms: number, kind: 'retry' | 'poll') => void;

export interface GameSyncOptions {
  gameId: string;
  deviceId: string;
  transport: SyncTransport;
  store: LocalStore;
  /** Retry delay after a network failure while online. */
  retryMs?: number;
  /** Safety-net catch-up interval while connected (a lost final broadcast leaves no gap to notice). */
  pollMs?: number;
  /** Injected for deterministic tests; defaults to setTimeout. */
  setTimer?: Timer;
}

/**
 * One game on one device. Taps apply to local state synchronously; persistence, the fast path
 * and the durable path all happen after, without blocking the render.
 */
export class GameSync {
  readonly log = new GameLog();
  readonly gameId: string;
  readonly deviceId: string;
  /** This device's events the server refused. Never resent; shown for admin review. */
  readonly rejected: StoredEvent[] = [];
  online = false;
  /** Server clock minus local clock, in ms. Use `now()` for event wallClocks. */
  clockOffset = 0;

  onChange: () => void = () => {};
  onRejected: (event: GameEvent, reason: string) => void = () => {};
  /** Two or more devices corrected the same event. `corrections` is oldest first; the last wins. */
  onConflict: (targetId: string, corrections: EventOf<'amend' | 'void'>[]) => void = () => {};

  private readonly transport: SyncTransport;
  private readonly store: LocalStore;
  private readonly retryMs: number;
  private readonly pollMs: number;
  private readonly setTimer: Timer;
  /** Own unconfirmed events, in deviceSeq order. */
  private pending: GameEvent[] = [];
  private deviceSeq = 0;
  /** Highest seq with every seq up to it received. Catch-up fetches after this. */
  private contiguous = 0;
  private ahead = new Set<number>();
  private flushing = false;
  private catchingUp = false;
  private retryScheduled = false;
  private closed = false;

  private constructor(o: GameSyncOptions) {
    this.gameId = o.gameId;
    this.deviceId = o.deviceId;
    this.transport = o.transport;
    this.store = o.store;
    this.retryMs = o.retryMs ?? 2000;
    this.pollMs = o.pollMs ?? 10_000;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  /** Load everything this device has stored for the game, then connect. */
  static async open(o: GameSyncOptions): Promise<GameSync> {
    const sync = new GameSync(o);
    for (const { event, rejected } of await o.store.load(o.gameId)) {
      if (event.deviceId === sync.deviceId) sync.deviceSeq = Math.max(sync.deviceSeq, event.deviceSeq);
      if (rejected !== undefined) {
        sync.rejected.push({ event, rejected });
        continue;
      }
      sync.log.add(event);
      if (event.seq !== null) sync.noteSeq(event.seq, false);
      else if (event.deviceId === sync.deviceId) sync.pending.push(event);
    }
    sync.pending.sort((a, b) => a.deviceSeq - b.deviceSeq);
    o.transport.connect({
      onEvent: (raw) => sync.receive(raw),
      onDiscard: (id) => sync.discard(id),
      onStatus: (status) => sync.setStatus(status),
    });
    sync.poll();
    return sync;
  }

  nextDeviceSeq(): number {
    return this.deviceSeq + 1;
  }

  /** Local time corrected to the server clock. */
  now(): number {
    return Date.now() + this.clockOffset;
  }

  /** The tap path. Synchronous state update; everything else is fire-and-forget. */
  record(e: GameEvent): void {
    this.deviceSeq = Math.max(this.deviceSeq, e.deviceSeq);
    this.log.add(e);
    this.onChange();
    void this.store.put(e);
    this.pending.push(e);
    this.transport.broadcast({ kind: 'event', event: e });
    void this.flush();
  }

  close() {
    this.closed = true;
    this.transport.close();
  }

  private receive(raw: unknown) {
    const parsed = parseEvent(raw);
    if (!parsed.success || parsed.output.gameId !== this.gameId) return;
    this.apply(parsed.output);
  }

  private apply(e: GameEvent) {
    if (e.seq !== null) {
      // Our own event confirmed (possibly via broadcast after a lost ack).
      if (e.deviceId === this.deviceId) this.pending = this.pending.filter((p) => p.id !== e.id);
      this.noteSeq(e.seq, true);
    }
    if (this.log.add(e) === -1) return;
    void this.store.put(e);
    if (isCorrection(e)) this.checkConflict(e.payload.targetId);
    this.onChange();
  }

  private checkConflict(targetId: string) {
    const corrections = this.log.correctionsFor(targetId);
    if (new Set(corrections.map((c) => c.deviceId)).size > 1) this.onConflict(targetId, corrections);
  }

  private discard(id: string) {
    const e = this.log.get(id);
    if (!e || this.log.discard(id) === -1) return;
    void this.store.put(e, 'rejected by the server');
    this.onChange();
  }

  private setStatus(status: 'online' | 'offline') {
    this.online = status === 'online';
    if (!this.online) return;
    void this.syncClock();
    void this.catchUp();
    void this.flush();
  }

  private noteSeq(seq: number, fetchGaps: boolean) {
    if (seq <= this.contiguous) return;
    this.ahead.add(seq);
    while (this.ahead.delete(this.contiguous + 1)) this.contiguous++;
    if (fetchGaps && this.ahead.size) void this.catchUp();
  }

  private async catchUp() {
    if (this.catchingUp || !this.online || this.closed) return;
    this.catchingUp = true;
    try {
      for (const e of await this.transport.fetchSince(this.contiguous)) this.receive(e);
    } catch (err) {
      if (!(err instanceof NetworkError)) throw err;
    } finally {
      this.catchingUp = false;
    }
  }

  /** Send the outbox in order, one at a time. Stops at the first network failure. */
  private async flush() {
    if (this.flushing || !this.online || this.closed) return;
    this.flushing = true;
    try {
      while (this.online && this.pending.length) {
        const e = this.pending[0]!;
        try {
          const seq = await this.transport.persist(e);
          this.apply({ ...e, seq });
        } catch (err) {
          if (err instanceof Rejected) {
            this.reject(e, err.message);
          } else if (err instanceof NetworkError) {
            this.retryLater();
            break;
          } else {
            throw err;
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private reject(e: GameEvent, reason: string) {
    this.pending = this.pending.filter((p) => p.id !== e.id);
    this.rejected.push({ event: e, rejected: reason });
    void this.store.put(e, reason);
    this.log.discard(e.id);
    this.transport.broadcast({ kind: 'discard', eventId: e.id });
    this.onRejected(e, reason);
    this.onChange();
  }

  private poll() {
    if (this.closed) return;
    void this.catchUp();
    this.setTimer(() => this.poll(), this.pollMs, 'poll');
  }

  private retryLater() {
    if (this.retryScheduled) return;
    this.retryScheduled = true;
    this.setTimer(() => {
      this.retryScheduled = false;
      void this.flush();
    }, this.retryMs, 'retry');
  }

  /** Estimate the server clock offset from one round trip (NTP-style midpoint). */
  private async syncClock() {
    try {
      const sent = Date.now();
      const server = await this.transport.serverTime();
      this.clockOffset = server - (sent + Date.now()) / 2;
    } catch (err) {
      if (!(err instanceof NetworkError)) throw err;
    }
  }
}
