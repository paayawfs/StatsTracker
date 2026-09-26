import 'fake-indexeddb/auto';
import type { GameEvent } from '@stats/core';
import { afterEach, describe, expect, test } from 'vitest';
import { LocalStore } from './store';

let n = 0;
const event = (over: Partial<GameEvent> = {}): GameEvent =>
  ({
    id: `e${++n}`, gameId: 'g1', seq: null, deviceId: 'd', deviceSeq: n, role: 'single',
    period: 1, gameClock: 600_000, wallClock: n, type: 'clockStart', payload: {}, ...over,
  }) as GameEvent;

let db = 0;
let store: LocalStore;
const open = async () => (store = await LocalStore.open(`test-${db}`));
afterEach(() => {
  store?.close();
  db++;
});

describe('LocalStore', () => {
  test('stores and loads events for a game', async () => {
    await open();
    const a = event();
    const other = event({ gameId: 'g2' });
    await store.put(a);
    await store.put(other);
    expect(await store.load('g1')).toEqual([{ event: a }]);
  });

  test('persists across reopen', async () => {
    await open();
    const a = event();
    await store.put(a);
    store.close();
    await open();
    expect(await store.load('g1')).toEqual([{ event: a }]);
  });

  test('durable version replaces unconfirmed, never the reverse', async () => {
    await open();
    const local = event();
    const durable = { ...local, seq: 7 };
    await store.put(local);
    await store.put(durable);
    await store.put(local);
    expect(await store.load('g1')).toEqual([{ event: durable }]);
  });

  test('marks an event rejected with the reason', async () => {
    await open();
    const a = event();
    await store.put(a);
    await store.put(a, 'role teamA is held by another device');
    expect(await store.load('g1')).toEqual([{ event: a, rejected: 'role teamA is held by another device' }]);
  });

  test('writes complete in order even when not awaited', async () => {
    await open();
    const events = Array.from({ length: 200 }, () => event());
    for (const e of events) void store.put(e);
    await store.put(event({ gameId: 'flush' }));
    expect((await store.load('g1')).map((s) => s.event.id)).toEqual(events.map((e) => e.id).sort());
  });
});
