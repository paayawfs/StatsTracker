import { GameLog, type GameEvent } from '@stats/core';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { SimNetwork, type NetworkConditions } from './sim';
import { client, conditions, players, startGame, tap } from './test-helpers';
import type { GameSync } from './game-sync';

const POLL = 10_000;

/** Build the reference log from what the server holds. */
const reference = (server: GameEvent[]) => {
  const g = new GameLog();
  for (const e of server) g.add(e);
  return g;
};

const randomEvent = (sync: GameSync, kind: number, k: number, known: GameEvent[]): GameEvent => {
  const p = players(k % 2 ? 'A' : 'B')[k % 8]!;
  switch (kind) {
    case 0: return tap(sync, 'shot', { shooter: p, value: k % 3 ? 2 : 3, made: k % 2 === 0 });
    case 1: return tap(sync, 'timeout', { team: k % 2 ? 'A' : 'B' });
    case 2: return tap(sync, 'rebound', { team: k % 2 ? 'A' : 'B', kind: 'defensive' });
    case 3: {
      const target = known[k % Math.max(known.length, 1)];
      return target ? tap(sync, 'void', { targetId: target.id }) : tap(sync, 'clockStop', {});
    }
    default: {
      const target = known[k % Math.max(known.length, 1)];
      return target
        ? tap(sync, 'amend', { targetId: target.id, body: { type: 'shot', payload: { shooter: p, value: 3, made: true } } })
        : tap(sync, 'clockStart', {});
    }
  }
};

type Step = { who: number; op: 'tap' | 'toggle' | 'wait'; kind: number; k: number };
const arbStep = (clients: number): fc.Arbitrary<Step> =>
  fc.record({
    who: fc.nat(clients - 1),
    op: fc.constantFrom('tap', 'tap', 'tap', 'toggle', 'wait'),
    kind: fc.nat(4),
    k: fc.nat(40),
  });
const arbConditions = fc.record({
  minDelay: fc.integer({ min: 1, max: 5 }),
  maxDelay: fc.integer({ min: 5, max: 40 }),
  drop: fc.double({ min: 0, max: 0.4, noNaN: true }),
  duplicate: fc.double({ min: 0, max: 0.3, noNaN: true }),
  lostAck: fc.double({ min: 0, max: 0.3, noNaN: true }),
});

async function runScenario(clientCount: number, cond: NetworkConditions, steps: Step[], seed: number) {
  const net = new SimNetwork(cond, seed);
  const clients = [];
  for (let i = 0; i < clientCount; i++) clients.push(await client(net, `dev${i}`));
  await net.settle();
  startGame(clients[0]!.sync);

  for (const s of steps) {
    const c = clients[s.who]!;
    if (s.op === 'tap') c.sync.record(randomEvent(c.sync, s.kind, s.k, c.sync.log.events));
    else if (s.op === 'toggle') c.t.setOnline(!c.t.online);
    else await net.step(s.k);
  }

  // Heal: perfect network, everyone online, let retries and polls run.
  net.conditions = conditions();
  for (const c of clients) c.t.setOnline(true);
  await net.settle();
  await net.advance(POLL * 2);
  await net.settle();

  const ref = reference(net.server);
  for (const c of clients) {
    expect(c.sync.log.events).toEqual(ref.events);
    expect(c.sync.log.state).toEqual(ref.state);
  }
  // Every tap made it to the server exactly once.
  const tapped = clients.flatMap((c) => c.sync.log.events.filter((e) => e.deviceId === c.sync.deviceId));
  expect(new Set(net.server.map((e) => e.id)).size).toBe(net.server.length);
  expect(tapped.every((e) => e.seq !== null)).toBe(true);
  for (const c of clients) c.sync.close();
}

describe('convergence under a hostile network', () => {
  test.each([2, 3])('%i clients converge to the server log', async (n) => {
    await fc.assert(
      fc.asyncProperty(arbConditions, fc.array(arbStep(n), { maxLength: 40 }), fc.integer(), (cond, steps, seed) =>
        runScenario(n, cond, steps, seed),
      ),
      { numRuns: 60 },
    );
  }, 120_000);
});

describe('catch-up', () => {
  test('a device that missed the last event gets it from the poll', async () => {
    const net = new SimNetwork();
    const a = await client(net, 'A');
    const b = await client(net, 'B');
    await net.settle();
    net.conditions = conditions({ drop: 1 }); // both fast path and server broadcast lost
    a.sync.record(tap(a.sync, 'clockStart', {}));
    await net.settle();
    expect(b.sync.log.events).toHaveLength(0);
    await net.advance(POLL);
    await net.settle();
    expect(b.sync.log.events).toHaveLength(1);
  });

  test('a device that was offline catches up on reconnect', async () => {
    const net = new SimNetwork();
    const a = await client(net, 'A');
    const b = await client(net, 'B');
    await net.settle();
    b.t.setOnline(false);
    for (let i = 0; i < 5; i++) a.sync.record(tap(a.sync, 'timeout', { team: 'A' }));
    await net.settle();
    expect(b.sync.log.events).toHaveLength(0);
    b.t.setOnline(true);
    await net.settle();
    expect(b.sync.log.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  test('a gap in received seqs triggers an immediate fetch', async () => {
    const net = new SimNetwork();
    const a = await client(net, 'A');
    const b = await client(net, 'B');
    await net.settle();
    net.conditions = conditions({ drop: 1 });
    a.sync.record(tap(a.sync, 'timeout', { team: 'A' }));
    await net.settle();
    net.conditions = conditions();
    a.sync.record(tap(a.sync, 'timeout', { team: 'B' }));
    await net.settle(); // no poll: seq 2 arriving reveals the missing seq 1
    expect(b.sync.log.events.map((e) => e.seq)).toEqual([1, 2]);
  });
});
