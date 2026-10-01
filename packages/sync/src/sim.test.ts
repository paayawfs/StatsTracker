import type { GameEvent } from '@stats/core';
import { describe, expect, test } from 'vitest';
import { SimNetwork } from './sim';
import { NetworkError, Rejected, type TransportHandlers } from './transport';

let n = 0;
const event = (): GameEvent => ({
  id: `e${++n}`, gameId: 'g', seq: null, deviceId: 'd', deviceSeq: n, role: 'single',
  period: 1, gameClock: 600_000, wallClock: n, type: 'clockStart', payload: {},
});

const recorder = () => {
  const got: { events: unknown[]; discards: string[]; status: string[] } = { events: [], discards: [], status: [] };
  const handlers: TransportHandlers = {
    onEvent: (e) => got.events.push(e),
    onDiscard: (id) => got.discards.push(id),
    onStatus: (s) => got.status.push(s),
  };
  return { got, handlers };
};

describe('SimNetwork', () => {
  test('persist assigns increasing seqs and dedupes resends', async () => {
    const net = new SimNetwork();
    const t = net.transport();
    const e = event();
    const seqs = Promise.all([t.persist([e]), t.persist([event()]), t.persist([e])]);
    await net.settle();
    expect(await seqs).toEqual([[1], [2], [1]]);
    expect(net.server).toHaveLength(2);
  });

  test('a refused event comes back as Rejected; the rest of the batch still goes in', async () => {
    const net = new SimNetwork();
    const bad = event();
    net.rejectIf = (e) => (e.id === bad.id ? 'nope' : null);
    const p = net.transport().persist([event(), bad, event()]);
    await net.settle();
    const [a, b, c] = await p;
    expect([a, c]).toEqual([1, 2]);
    expect(b).toBeInstanceOf(Rejected);
    expect(net.server).toHaveLength(2);
  });

  test('durable events fan out to every online client, including the writer', async () => {
    const net = new SimNetwork();
    const [a, b, c] = [net.transport(), net.transport(), net.transport()];
    const [ra, rb, rc] = [recorder(), recorder(), recorder()];
    a.connect(ra.handlers);
    b.connect(rb.handlers);
    c.connect(rc.handlers);
    c.setOnline(false);
    void a.persist([event()]);
    await net.settle();
    expect(ra.got.events).toHaveLength(1);
    expect(rb.got.events).toMatchObject([{ seq: 1 }]);
    expect(rc.got.events).toHaveLength(0);
  });

  test('broadcast reaches online peers but not the sender', async () => {
    const net = new SimNetwork();
    const [a, b] = [net.transport(), net.transport()];
    const [ra, rb] = [recorder(), recorder()];
    a.connect(ra.handlers);
    b.connect(rb.handlers);
    a.broadcast({ kind: 'event', event: event() });
    a.broadcast({ kind: 'discard', eventId: 'x' });
    await net.settle();
    expect(ra.got.events).toHaveLength(0);
    expect(rb.got.events).toHaveLength(1);
    expect(rb.got.discards).toEqual(['x']);
  });

  test('drop = 1 loses every broadcast', async () => {
    const net = new SimNetwork({ minDelay: 1, maxDelay: 1, drop: 1, duplicate: 0, lostAck: 0 });
    const [a, b] = [net.transport(), net.transport()];
    const rb = recorder();
    a.connect(recorder().handlers);
    b.connect(rb.handlers);
    a.broadcast({ kind: 'event', event: event() });
    await net.settle();
    expect(rb.got.events).toHaveLength(0);
  });

  test('lost ack: persist fails with NetworkError but the server has the event', async () => {
    const net = new SimNetwork({ minDelay: 1, maxDelay: 1, drop: 0, duplicate: 0, lostAck: 1 });
    const p = net.transport().persist([event()]).catch((e: unknown) => e);
    await net.settle();
    expect(await p).toBeInstanceOf(NetworkError);
    expect(net.server).toHaveLength(1);
  });

  test('offline: persist, fetch and serverTime fail; status is reported', async () => {
    const net = new SimNetwork();
    const t = net.transport();
    const r = recorder();
    t.connect(r.handlers);
    await net.settle();
    t.setOnline(false);
    const results = Promise.allSettled([t.persist([event()]), t.fetchSince(0), t.serverTime()]);
    await net.settle();
    expect((await results).map((x) => x.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(r.got.status).toEqual(['online', 'offline']);
  });

  test('fetchSince returns durable events after a seq', async () => {
    const net = new SimNetwork();
    const t = net.transport();
    for (let i = 0; i < 3; i++) void t.persist([event()]);
    await net.settle();
    const p = t.fetchSince(1);
    await net.settle();
    expect((await p).map((e) => e.seq)).toEqual([2, 3]);
  });

  test('same seed, same random sequence', () => {
    const a = new SimNetwork(undefined, 42);
    const b = new SimNetwork(undefined, 42);
    expect([a.random(), a.random()]).toEqual([b.random(), b.random()]);
  });
});
