import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { compareEvents, GameLog } from './log';
import { replay } from './reducer';
import { arbGameLog, ev, gameStart, periodStart } from './test-helpers';

const shot = (env = {}) => ev('shot', { shooter: 'a1', value: 2, made: true }, env);

describe('compareEvents', () => {
  const order = (...es: ReturnType<typeof shot>[]) => [...es].sort(compareEvents).map((e) => e.id);

  test('earlier period first', () => {
    const a = shot({ period: 2, gameClock: 500 });
    const b = shot({ period: 1, gameClock: 100 });
    expect(order(a, b)).toEqual([b.id, a.id]);
  });

  test('more time remaining first', () => {
    const a = shot({ gameClock: 100 });
    const b = shot({ gameClock: 500 });
    expect(order(a, b)).toEqual([b.id, a.id]);
  });

  test('same clock: lower seq first, unconfirmed last', () => {
    const a = shot({ gameClock: 100, seq: null, wallClock: 1 });
    const b = shot({ gameClock: 100, seq: 9 });
    const c = shot({ gameClock: 100, seq: 3 });
    expect(order(a, b, c)).toEqual([c.id, b.id, a.id]);
  });

  test('same clock, both unconfirmed: wall clock, then id', () => {
    const a = shot({ gameClock: 100, seq: null, wallClock: 20 });
    const b = shot({ gameClock: 100, seq: null, wallClock: 10 });
    const c = shot({ gameClock: 100, seq: null, wallClock: 10, id: 'zz' });
    expect(order(a, b, c)).toEqual([b.id, c.id, a.id]);
  });
});

describe('GameLog', () => {
  test('in-order adds give the same state as replay', () => {
    fc.assert(
      fc.property(arbGameLog, (log) => {
        const g = new GameLog();
        for (const e of log) g.add(e);
        expect(g.events).toEqual(log);
        expect(g.state).toEqual(replay(log));
      }),
    );
  });

  test('any arrival order converges to the canonical log and state', () => {
    fc.assert(
      fc.property(arbGameLog.chain((log) => fc.tuple(fc.constant(log), fc.shuffledSubarray(log, { minLength: log.length }))),
        ([log, arrival]) => {
          const g = new GameLog();
          for (const e of arrival) g.add(e);
          expect(g.events).toEqual(log);
          expect(g.state).toEqual(replay(log));
        }),
    );
  });

  test('duplicate adds are no-ops', () => {
    fc.assert(
      fc.property(arbGameLog, (log) => {
        const g = new GameLog();
        for (const e of log) {
          g.add(e);
          expect(g.add(structuredClone(e))).toBe(-1);
        }
        expect(g.state).toEqual(replay(log));
      }),
    );
  });

  test('appending at the end replays only the new event', () => {
    const g = new GameLog();
    g.add(gameStart());
    g.add(periodStart());
    expect(g.add(shot())).toBe(2);
  });

  test('a late event replays from its insertion point', () => {
    const g = new GameLog();
    const [a, b, c] = [gameStart(), periodStart(), shot({ gameClock: 500_000 })];
    const late = shot({ gameClock: 599_000, seq: 999 });
    for (const e of [a, b, c]) g.add(e);
    expect(g.add(late)).toBe(2);
    expect(g.events.map((e) => e.id)).toEqual([a.id, b.id, late.id, c.id]);
    expect(g.state.score.A).toBe(4);
  });

  test('the durable version replaces the unconfirmed one', () => {
    const g = new GameLog();
    g.add(gameStart());
    g.add(periodStart());
    const local = shot({ seq: null });
    g.add(local);
    const durable = { ...local, seq: 42, payload: { ...local.payload, value: 3 as const } };
    g.add(durable);
    expect(g.events).toHaveLength(3);
    expect(g.events[2]).toEqual(durable);
    expect(g.state.score.A).toBe(3);
  });

  test('a stale unconfirmed copy never replaces the durable version', () => {
    const g = new GameLog();
    const durable = shot({ seq: 5 });
    g.add(durable);
    expect(g.add({ ...durable, seq: null })).toBe(-1);
    expect(g.events).toEqual([durable]);
  });
});
