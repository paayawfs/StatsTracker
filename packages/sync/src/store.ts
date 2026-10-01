import type { GameEvent } from '@stats/core';
import { openDB, type IDBPDatabase } from 'idb';

export interface StoredEvent {
  event: GameEvent;
  /** Set when the server refused the event. Kept for admin review, never resent. */
  rejected?: string;
}

/**
 * Every event this device knows for a game: its own (the outbox is the unconfirmed ones) and
 * peers'. Lets a scorer reload the page mid-game, offline, and lose nothing.
 */
export class LocalStore {
  private constructor(private readonly db: IDBPDatabase) {}

  static async open(name = 'stats-tracker'): Promise<LocalStore> {
    const db = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('events', { keyPath: 'event.id' }).createIndex('gameId', 'event.gameId');
      },
    });
    return new LocalStore(db);
  }

  /** Upsert. A durable (seq'd) copy is never replaced by an unconfirmed one. */
  async put(event: GameEvent, rejected?: string): Promise<void> {
    const tx = this.db.transaction('events', 'readwrite');
    const existing: StoredEvent | undefined = await tx.store.get(event.id);
    if (!(existing?.event.seq != null && event.seq === null && rejected === undefined)) {
      await tx.store.put(rejected === undefined ? { event } : { event, rejected });
    }
    await tx.done;
  }

  load(gameId: string): Promise<StoredEvent[]> {
    return this.db.getAllFromIndex('events', 'gameId', gameId);
  }

  /**
   * Drop other games once their newest event is a week old. A game where this device still has
   * unsynced events is kept: they may be the only copy.
   */
  // ponytail: reads every stored event once per game open; keep a per-game summary if that gets slow.
  async prune(keep: string, deviceId: string, now = Date.now(), maxAgeMs = 7 * 86_400_000): Promise<void> {
    const games = new Map<string, { last: number; pending: boolean }>();
    for (const { event, rejected } of (await this.db.getAll('events')) as StoredEvent[]) {
      const g = games.get(event.gameId) ?? { last: 0, pending: false };
      g.last = Math.max(g.last, event.wallClock);
      g.pending ||= event.deviceId === deviceId && event.seq === null && rejected === undefined;
      games.set(event.gameId, g);
    }
    for (const [id, g] of games) {
      if (id === keep || g.pending || now - g.last < maxAgeMs) continue;
      const tx = this.db.transaction('events', 'readwrite');
      for (const key of await tx.store.index('gameId').getAllKeys(id)) await tx.store.delete(key);
      await tx.done;
    }
  }

  close() {
    this.db.close();
  }
}
