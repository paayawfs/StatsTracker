import type { GameEvent } from '@stats/core';
import { NetworkError, Rejected, type PeerMessage, type SyncTransport, type TransportHandlers } from './transport';

/**
 * A deterministic simulated backend for tests: one server, many clients, a network with
 * latency, drops, duplicates, reordering and outages. Time is virtual; `settle()` runs it.
 */
export interface NetworkConditions {
  minDelay: number;
  maxDelay: number;
  /** Probability a fast-path or server broadcast message is lost. */
  drop: number;
  /** Probability a delivered message is delivered twice. */
  duplicate: number;
  /** Probability the server applies a persist but the response is lost. */
  lostAck: number;
}

const perfect: NetworkConditions = { minDelay: 1, maxDelay: 1, drop: 0, duplicate: 0, lostAck: 0 };

export class SimNetwork {
  readonly server: GameEvent[] = [];
  /** Return a rejection reason to make the server refuse an event. */
  rejectIf: (e: GameEvent) => string | null = () => null;
  now = 0;
  private queue: { at: number; order: number; run: () => void }[] = [];
  private order = 0;
  private seed: number;
  readonly transports: SimTransport[] = [];

  constructor(
    public conditions: NetworkConditions = perfect,
    seed = 1,
  ) {
    this.seed = seed;
  }

  /** Mulberry32: small seeded PRNG so failures reproduce. */
  random(): number {
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  transport(): SimTransport {
    const t = new SimTransport(this);
    this.transports.push(t);
    return t;
  }

  schedule(run: () => void, delay = this.delay()) {
    this.queue.push({ at: this.now + delay, order: this.order++, run });
  }

  delay(): number {
    const { minDelay, maxDelay } = this.conditions;
    return minDelay + Math.floor(this.random() * (maxDelay - minDelay + 1));
  }

  /** Deliver a message subject to drops and duplicates. */
  deliver(run: () => void) {
    if (this.random() < this.conditions.drop) return;
    this.schedule(run);
    if (this.random() < this.conditions.duplicate) this.schedule(run);
  }

  /** Server side of persist: dedupe by id, check rejection, assign seq, fan out. */
  apply(e: GameEvent): number {
    const existing = this.server.find((s) => s.id === e.id);
    if (existing) return existing.seq!;
    const reason = this.rejectIf(e);
    if (reason) throw new Rejected('42501', reason);
    const durable = { ...e, seq: this.server.length + 1 };
    this.server.push(durable);
    for (const t of this.transports) if (t.online && t.handlers) this.deliver(() => t.receive(durable));
    return durable.seq;
  }

  /** Run virtual time until nothing is queued, letting promise callbacks run between steps. */
  async settle(maxSteps = 100_000) {
    for (let i = 0; i < maxSteps; i++) {
      await flushMicrotasks();
      if (!this.queue.length) return;
      this.queue.sort((a, b) => a.at - b.at || a.order - b.order);
      const next = this.queue.shift()!;
      this.now = Math.max(this.now, next.at);
      next.run();
    }
    throw new Error('network did not settle');
  }
}

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

export class SimTransport implements SyncTransport {
  online = true;
  handlers?: TransportHandlers;

  constructor(private readonly net: SimNetwork) {}

  connect(handlers: TransportHandlers) {
    this.handlers = handlers;
    if (this.online) this.net.schedule(() => handlers.onStatus('online'));
  }

  setOnline(online: boolean) {
    if (this.online === online) return;
    this.online = online;
    const h = this.handlers;
    if (h) this.net.schedule(() => h.onStatus(online ? 'online' : 'offline'), 0);
  }

  receive(e: GameEvent) {
    if (this.online) this.handlers?.onEvent(structuredClone(e));
  }

  broadcast(message: PeerMessage) {
    if (!this.online) return;
    for (const t of this.net.transports) {
      if (t === this || !t.online || !t.handlers) continue;
      const h = t.handlers;
      this.net.deliver(() => {
        if (!t.online) return;
        if (message.kind === 'event') h.onEvent(structuredClone(message.event));
        else h.onDiscard(message.eventId);
      });
    }
  }

  persist(e: GameEvent): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!this.online) return this.net.schedule(() => reject(new NetworkError('offline')));
      this.net.schedule(() => {
        let seq: number;
        try {
          seq = this.net.apply(structuredClone(e));
        } catch (err) {
          return this.net.schedule(() => reject(err));
        }
        const lost = !this.online || this.net.random() < this.net.conditions.lostAck;
        this.net.schedule(() => (lost ? reject(new NetworkError('response lost')) : resolve(seq)));
      });
    });
  }

  fetchSince(afterSeq: number): Promise<GameEvent[]> {
    return new Promise((resolve, reject) =>
      this.net.schedule(() =>
        this.online ? resolve(structuredClone(this.net.server.filter((e) => e.seq! > afterSeq))) : reject(new NetworkError('offline')),
      ),
    );
  }

  serverTime(): Promise<number> {
    return new Promise((resolve, reject) =>
      this.net.schedule(() => (this.online ? resolve(this.net.now) : reject(new NetworkError('offline')))),
    );
  }

  close() {
    this.handlers = undefined;
  }
}
