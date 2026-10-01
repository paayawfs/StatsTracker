import type { GameEvent } from '@stats/core';

/**
 * Everything the sync engine needs from a backend. Supabase today; swapping to e.g. Durable
 * Objects means a new implementation of this, with no change to core, GameSync or the UI.
 */
export interface SyncTransport {
  /** Join the game's channel. Handlers fire for the lifetime of the connection. */
  connect(handlers: TransportHandlers): void;
  /** Fast path: fire-and-forget to peers. Never awaited on the tap path. */
  broadcast(message: PeerMessage): void;
  /**
   * Durable path for a batch, in order. Resolves with each event's canonical seq, or `Rejected`
   * for an event the server refused (the others still go in). Throws `NetworkError`.
   */
  persist(events: GameEvent[]): Promise<(number | Rejected)[]>;
  /** Durable events with seq > afterSeq, in seq order. Throws `NetworkError`. */
  fetchSince(afterSeq: number): Promise<GameEvent[]>;
  /** Server clock in epoch ms. Throws `NetworkError`. */
  serverTime(): Promise<number>;
  close(): void;
}

export interface TransportHandlers {
  /** An event from a peer (unconfirmed, seq null) or the server (durable, seq set). */
  onEvent(event: unknown): void;
  /** A peer's event was rejected by the server: drop it if still unconfirmed. */
  onDiscard(eventId: string): void;
  onStatus(status: 'online' | 'offline'): void;
}

export type PeerMessage = { kind: 'event'; event: GameEvent } | { kind: 'discard'; eventId: string };

/** The server refused the event (authority, schema, lock). Retrying will not help. */
export class Rejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The request may or may not have reached the server. Retry later; resends are idempotent. */
export class NetworkError extends Error {}
