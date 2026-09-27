import { describe, expect, test, vi } from 'vitest';
import { SimNetwork } from './sim';
import { client, conditions, startGame, tap } from './test-helpers';

const shot = (sync: Parameters<typeof tap>[0], shooter = 'a1', made = true) =>
  tap(sync, 'shot', { shooter, value: 2, made });

describe('record', () => {
  test('applies to local state synchronously, before any network', async () => {
    const net = new SimNetwork();
    const { sync } = await client(net, 'A');
    startGame(sync);
    sync.record(shot(sync));
    expect(sync.log.state.score.A).toBe(2);
    expect(net.server).toHaveLength(0);
  });

  test('persists to the server and confirms locally', async () => {
    const net = new SimNetwork();
    const { sync, store } = await client(net, 'A');
    startGame(sync);
    sync.record(shot(sync));
    await net.settle();
    expect(net.server.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(sync.log.events.every((e) => e.seq !== null)).toBe(true);
    expect((await store.load('g1')).every((s) => s.event.seq !== null)).toBe(true);
  });

  test('peers see the fast-path event, then the durable one', async () => {
    const net = new SimNetwork(conditions({ minDelay: 1, maxDelay: 1 }));
    const a = await client(net, 'A');
    const b = await client(net, 'B');
    await net.settle();
    startGame(a.sync);
    await net.settle();
    const s = shot(a.sync);
    a.sync.record(s);
    // One network hop: B has the broadcast but the persist round trip hasn't finished.
    await net.step(2);
    expect(b.sync.log.get(s.id)?.seq ?? null).toBeNull();
    expect(b.sync.log.state.score.A).toBe(2);
    await net.settle();
    expect(b.sync.log.get(s.id)?.seq).toBe(3);
  });

  test('nextDeviceSeq increases per device', async () => {
    const net = new SimNetwork();
    const { sync } = await client(net, 'A');
    const first = sync.nextDeviceSeq();
    sync.record(tap(sync, 'clockStart', {}));
    expect(sync.nextDeviceSeq()).toBe(first + 1);
  });
});

describe('outbox', () => {
  test('offline taps queue, then flush in device order when back online', async () => {
    const net = new SimNetwork();
    const { sync, t } = await client(net, 'A');
    await net.settle();
    t.setOnline(false);
    await net.settle();
    startGame(sync);
    for (let i = 0; i < 5; i++) sync.record(shot(sync));
    await net.settle();
    expect(net.server).toHaveLength(0);
    expect(sync.log.state.score.A).toBe(10);
    t.setOnline(true);
    await net.settle();
    expect(net.server.map((e) => e.deviceSeq)).toEqual([...net.server.map((e) => e.deviceSeq)].sort((x, y) => x - y));
    expect(net.server).toHaveLength(7);
  });

  test('a reload while offline restores state and still sends the outbox', async () => {
    const net = new SimNetwork();
    const first = await client(net, 'A');
    await net.settle();
    first.t.setOnline(false);
    await net.settle();
    startGame(first.sync);
    first.sync.record(shot(first.sync));
    await Promise.resolve();
    first.sync.close();

    const second = await client(net, 'A', first.store);
    expect(second.sync.log.state.score.A).toBe(2);
    await net.settle();
    expect(net.server).toHaveLength(3);
    expect(second.sync.nextDeviceSeq()).toBeGreaterThan(3);
  });

  test('lost ack: confirmed by the durable broadcast, sent only once', async () => {
    const net = new SimNetwork(conditions({ lostAck: 1 }));
    const { sync } = await client(net, 'A');
    await net.settle();
    startGame(sync);
    await net.settle();
    expect(net.server).toHaveLength(2);
    expect(sync.log.events.every((e) => e.seq !== null)).toBe(true);
  });

  test('lost ack and lost broadcast: the retry is idempotent', async () => {
    const net = new SimNetwork(conditions({ lostAck: 1, drop: 1 }));
    const { sync } = await client(net, 'A');
    await net.settle();
    sync.record(tap(sync, 'clockStart', {}));
    await net.step(50);
    net.conditions = conditions();
    await net.settle();
    expect(net.server).toHaveLength(1);
    expect(sync.log.events[0]?.seq).toBe(1);
  });
});

describe('rejection', () => {
  test('a refused event is removed everywhere and kept locally as rejected', async () => {
    const net = new SimNetwork();
    const onRejected = vi.fn();
    const a = await client(net, 'A');
    const b = await client(net, 'B');
    a.sync.onRejected = onRejected;
    await net.settle();
    startGame(a.sync);
    await net.settle();
    net.rejectIf = (e) => (e.type === 'shot' ? 'teamB owns that shot' : null);
    const s = shot(a.sync);
    a.sync.record(s);
    await net.settle();
    expect(a.sync.log.get(s.id)).toBeUndefined();
    expect(b.sync.log.get(s.id)).toBeUndefined();
    expect(a.sync.log.state.score.A).toBe(0);
    expect(onRejected).toHaveBeenCalledWith(expect.objectContaining({ id: s.id }), 'teamB owns that shot');
    expect(a.sync.rejected.map((r) => r.event.id)).toEqual([s.id]);
    expect((await a.store.load('g1')).find((r) => r.event.id === s.id)?.rejected).toBe('teamB owns that shot');
    net.rejectIf = () => null;
    a.sync.record(tap(a.sync, 'clockStart', {}));
    await net.settle();
    expect(net.server).toHaveLength(3); // the rejected one is never resent
  });
});

describe('untrusted input', () => {
  test('malformed peer messages and other games are ignored', async () => {
    const net = new SimNetwork();
    const a = await client(net, 'A');
    await net.settle();
    a.t.handlers!.onEvent({ junk: true });
    a.t.handlers!.onEvent({ ...tap(a.sync, 'clockStart', {}), gameId: 'other' });
    expect(a.sync.log.events).toHaveLength(0);
  });
});

describe('record validation', () => {
  test('an invalid event from the UI is refused on the device, before it goes anywhere', async () => {
    const net = new SimNetwork();
    const { sync } = await client(net, 'A');
    const bad = { ...tap(sync, 'clockStart', {}), gameClock: 1.5 };
    expect(() => sync.record(bad)).toThrow(/invalid event/);
    expect(sync.log.events).toHaveLength(0);
    await net.settle();
    expect(net.server).toHaveLength(0);
  });
});
