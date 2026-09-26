import 'fake-indexeddb/auto';
import { FIBA, type EventOf, type EventType, type GameEvent } from '@stats/core';
import { GameSync } from './game-sync';
import type { NetworkConditions, SimNetwork } from './sim';
import { LocalStore } from './store';

let dbs = 0;
let clock = 600_000;

export const players = (t: 'A' | 'B') => Array.from({ length: 8 }, (_, i) => `${t.toLowerCase()}${i + 1}`);

/** A GameSync client on the simulated network with its own IndexedDB. */
export async function client(net: SimNetwork, deviceId: string, store?: LocalStore) {
  const t = net.transport();
  const s = store ?? (await LocalStore.open(`test-${deviceId}-${dbs++}`));
  const sync = await GameSync.open({
    gameId: 'g1',
    deviceId,
    transport: t,
    store: s,
    setTimer: (fn, ms) => net.schedule(fn, ms),
  });
  return { sync, t, store: s };
}

/** Build an event as the scorer UI would: next deviceSeq, current clock. */
export function tap<T extends EventType>(sync: GameSync, type: T, payload: EventOf<T>['payload'], env: Partial<GameEvent> = {}): EventOf<T> {
  return {
    id: crypto.randomUUID(),
    gameId: 'g1',
    seq: null,
    deviceId: sync.deviceId,
    deviceSeq: sync.nextDeviceSeq(),
    role: 'single',
    period: 1,
    gameClock: (clock -= 100),
    wallClock: Date.now(),
    ...env,
    type,
    payload,
  } as EventOf<T>;
}

export const startGame = (sync: GameSync) => {
  sync.record(
    tap(sync, 'gameStart', {
      rules: FIBA,
      shotLocations: false,
      roster: { A: players('A').map((playerId) => ({ playerId, jersey: '1' })), B: players('B').map((playerId) => ({ playerId, jersey: '1' })) },
    }, { period: 0, gameClock: 0 }),
  );
  sync.record(tap(sync, 'periodStart', { lineups: { A: players('A').slice(0, 5), B: players('B').slice(0, 5) } }, { gameClock: 600_000 }));
};

export const conditions = (over: Partial<NetworkConditions> = {}): NetworkConditions => ({
  minDelay: 1, maxDelay: 1, drop: 0, duplicate: 0, lostAck: 0, ...over,
});
