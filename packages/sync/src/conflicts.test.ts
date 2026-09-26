import type { EventOf } from '@stats/core';
import { describe, expect, test } from 'vitest';
import { SimNetwork } from './sim';
import { client, conditions, startGame, tap } from './test-helpers';

type Correction = EventOf<'amend' | 'void'>;

async function twoScorers() {
  const net = new SimNetwork(conditions({ minDelay: 5, maxDelay: 5 }));
  const a = await client(net, 'A');
  const b = await client(net, 'B');
  const notes: Record<string, Correction[][]> = { A: [], B: [] };
  a.sync.onConflict = (_, cs) => notes.A!.push(cs);
  b.sync.onConflict = (_, cs) => notes.B!.push(cs);
  await net.settle();
  startGame(a.sync);
  const shot = tap(a.sync, 'shot', { shooter: 'a1', value: 2, made: true });
  a.sync.record(shot);
  await net.settle();
  return { net, a, b, notes, shot };
}

describe('concurrent amendments', () => {
  test('both devices converge on the higher-seq amendment and both are notified', async () => {
    const { net, a, b, notes, shot } = await twoScorers();
    const fromA = tap(a.sync, 'amend', { targetId: shot.id, body: { type: 'shot', payload: { shooter: 'a1', value: 3, made: true } } });
    const fromB = tap(b.sync, 'amend', { targetId: shot.id, body: { type: 'shot', payload: { shooter: 'a2', value: 2, made: true } } });
    a.sync.record(fromA);
    b.sync.record(fromB); // concurrent: neither has seen the other
    await net.settle();

    const winner = [...net.server].filter((e) => e.type === 'amend').sort((x, y) => x.seq! - y.seq!).at(-1)!;
    for (const c of [a, b]) {
      expect(c.sync.log.correctionsFor(shot.id).at(-1)?.id).toBe(winner.id);
    }
    expect(a.sync.log.state).toEqual(b.sync.log.state);
    for (const who of ['A', 'B']) {
      expect(notes[who]!.length).toBeGreaterThan(0);
      expect(notes[who]!.at(-1)!.at(-1)!.id).toBe(winner.id);
      expect(new Set(notes[who]!.at(-1)!.map((c) => c.deviceId))).toEqual(new Set(['A', 'B']));
    }
  });

  test('no notification when one device corrects its own work', async () => {
    const { net, a, notes, shot } = await twoScorers();
    a.sync.record(tap(a.sync, 'amend', { targetId: shot.id, body: { type: 'shot', payload: { shooter: 'a1', value: 3, made: true } } }));
    a.sync.record(tap(a.sync, 'void', { targetId: shot.id }));
    await net.settle();
    expect(notes.A).toEqual([]);
    expect(notes.B).toEqual([]);
  });

  test('confirmations alone do not repeat the notification', async () => {
    const { net, a, b, notes, shot } = await twoScorers();
    b.sync.record(tap(b.sync, 'amend', { targetId: shot.id, body: { type: 'shot', payload: { shooter: 'a1', value: 3, made: true } } }));
    await net.settle();
    a.sync.record(tap(a.sync, 'void', { targetId: shot.id }));
    await net.settle();
    // A's void is newer, wins once seen; each device is told once (winner never flips back).
    expect(notes.A).toHaveLength(1);
    expect(notes.B).toHaveLength(1);
    expect(a.sync.log.state.score.A).toBe(0);
    expect(b.sync.log.state.score.A).toBe(0);
  });
});
