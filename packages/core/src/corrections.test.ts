import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { GameEvent } from './events';
import { GameLog } from './log';
import { replay } from './reducer';
import { arbGameLog, ev, gameStart, periodStart } from './test-helpers';

const build = (...events: GameEvent[]) => {
  const g = new GameLog();
  for (const e of events) g.add(e);
  return g;
};
const two = () => ev('shot', { shooter: 'a1', value: 2, made: true }, { gameClock: 500_000 });
const later = { gameClock: 100_000 };

describe('amend', () => {
  test('replaces the target payload', () => {
    const s = two();
    const g = build(gameStart(), periodStart(), s, ev('amend', { targetId: s.id, body: { type: 'shot', payload: { ...s.payload, value: 3 } } }, later));
    expect(g.state.score.A).toBe(3);
    expect(g.events.find((e) => e.id === s.id)).toMatchObject({ type: 'shot', payload: { value: 3 } });
  });

  test('can change the event type', () => {
    const s = two();
    const g = build(gameStart(), periodStart(), s, ev('amend', { targetId: s.id, body: { type: 'turnover', payload: { team: 'A', player: 'a1', kind: 'travelling' } } }, later));
    expect(g.state.score.A).toBe(0);
    expect(g.events.find((e) => e.id === s.id)?.type).toBe('turnover');
  });

  test('keeps the target in its original position', () => {
    const s = two();
    const after = ev('shot', { shooter: 'b1', value: 2, made: true }, { gameClock: 400_000 });
    const g = build(gameStart(), periodStart(), s, after, ev('amend', { targetId: s.id, body: { type: 'shot', payload: { ...s.payload, value: 3 } } }, later));
    expect(g.events.map((e) => e.id).indexOf(s.id)).toBe(2);
  });
});

describe('void', () => {
  test('removes the target from the effective log', () => {
    const s = two();
    const g = build(gameStart(), periodStart(), s, ev('void', { targetId: s.id }, later));
    expect(g.state.score.A).toBe(0);
    expect(g.events.some((e) => e.id === s.id)).toBe(false);
  });

  test('a void aimed at a correction is ignored', () => {
    const s = two();
    const amend = ev('amend', { targetId: s.id, body: { type: 'shot', payload: { ...s.payload, value: 3 } } }, later);
    const g = build(gameStart(), periodStart(), s, amend, ev('void', { targetId: amend.id }, later));
    expect(g.state.score.A).toBe(3);
  });

  test('void then replay equals never having the event', () => {
    fc.assert(
      fc.property(arbGameLog, fc.nat(), (log, k) => {
        const target = log[k % log.length]!;
        const last = log[log.length - 1]!;
        const g = build(...log, ev('void', { targetId: target.id }, { period: last.period, gameClock: 0 }));
        expect(g.state).toEqual(replay(log.filter((e) => e !== target)));
      }),
    );
  });
});

describe('last write wins by seq', () => {
  const setup = () => {
    const s = two();
    const a = ev('amend', { targetId: s.id, body: { type: 'shot', payload: { ...s.payload, value: 3 } } }, { ...later, seq: 50, deviceId: 'dA' });
    const b = ev('amend', { targetId: s.id, body: { type: 'shot', payload: { ...s.payload, made: false } } }, { ...later, seq: 60, deviceId: 'dB' });
    return { s, a, b };
  };

  test('higher seq wins whatever the arrival order', () => {
    const { s, a, b } = setup();
    expect(build(gameStart(), periodStart(), s, a, b).state.score.A).toBe(0);
    expect(build(gameStart(), periodStart(), s, b, a).state.score.A).toBe(0);
  });

  test('an unconfirmed local amend shows until a later durable one arrives', () => {
    const { s, a, b } = setup();
    const local = { ...a, seq: null };
    const g = build(gameStart(), periodStart(), s, local);
    expect(g.state.score.A).toBe(3);
    g.add(b);
    expect(g.state.score.A).toBe(3); // local still ranks last while unconfirmed
    g.add(a); // durable version of the local amend, seq 50 < 60
    expect(g.state.score.A).toBe(0);
  });

  test('a later amend restores a voided event', () => {
    const s = two();
    const g = build(
      gameStart(),
      periodStart(),
      s,
      ev('void', { targetId: s.id }, { ...later, seq: 10 }),
      ev('amend', { targetId: s.id, body: { type: 'shot', payload: s.payload } }, { ...later, seq: 11 }),
    );
    expect(g.state.score.A).toBe(2);
  });

  test('correctionsFor lists competing corrections, winner last', () => {
    const { s, a, b } = setup();
    const g = build(gameStart(), periodStart(), s, b, a);
    expect(g.correctionsFor(s.id).map((c) => c.id)).toEqual([a.id, b.id]);
  });
});

describe('ordering and arrival', () => {
  test('a correction that arrives before its target applies when the target arrives', () => {
    const s = two();
    const g = build(gameStart(), periodStart(), ev('void', { targetId: s.id }, later));
    g.add(s);
    expect(g.state.score.A).toBe(0);
  });

  test('corrections converge under any arrival order', () => {
    const arb = arbGameLog.chain((log) =>
      fc.tuple(fc.constant(log), fc.array(fc.tuple(fc.nat(), fc.boolean()), { maxLength: 5 })).chain(([log, picks]) => {
        const last = log[log.length - 1]!;
        const env = { period: last.period, gameClock: 0 };
        const corrections = picks.map(([k, isVoid]) => {
          const t = log[k % log.length]!;
          return isVoid
            ? ev('void', { targetId: t.id }, env)
            : ev('amend', { targetId: t.id, body: { type: 'timeout', payload: { team: 'A' } } }, env);
        });
        const all = [...log, ...corrections];
        return fc.tuple(fc.constant(all), fc.shuffledSubarray(all, { minLength: all.length }));
      }),
    );
    fc.assert(
      fc.property(arb, ([ordered, shuffled]) => {
        const a = build(...ordered);
        const b = build(...shuffled);
        expect(b.events).toEqual(a.events);
        expect(b.state).toEqual(a.state);
      }),
    );
  });
});

describe('admin lock', () => {
  test('non-admin corrections after lock are ignored and flagged, admin ones apply', () => {
    const s = two();
    const end = { gameClock: 0 };
    const lock = ev('adminLock', {}, { ...end, seq: 100 });
    const scorer = ev('void', { targetId: s.id }, { ...end, seq: 101, role: 'teamA' });
    const g = build(gameStart(), periodStart(), s, lock, scorer);
    expect(g.state.score.A).toBe(2);
    expect(g.state.flags.map((f) => f.code)).toEqual(['locked-correction']);

    g.add(ev('void', { targetId: s.id }, { ...end, seq: 102, role: 'admin' }));
    expect(g.state.score.A).toBe(0);
  });

  test('a lock arriving late still blocks later-seq scorer corrections', () => {
    const s = two();
    const end = { gameClock: 0 };
    const scorer = ev('void', { targetId: s.id }, { ...end, seq: 101, role: 'teamA' });
    const g = build(gameStart(), periodStart(), s, scorer);
    expect(g.state.score.A).toBe(0);
    g.add(ev('adminLock', {}, { ...end, seq: 100 }));
    expect(g.state.score.A).toBe(2);
  });
});
