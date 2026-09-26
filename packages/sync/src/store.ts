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

  close() {
    this.db.close();
  }
}
