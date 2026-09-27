import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { replay } from '../reducer';
import { arbGameLog } from '../test-helpers';
import { fixture, MIN } from './fixture';
import { lineups, onOff } from './lineups';
import { walk } from './walk';

describe('lineups on the hand-verified game', () => {
  const l = lineups(fixture());

  test('team A had two units, split by the 6:00 substitution', () => {
    expect(l.A).toEqual([
      { players: ['a1', 'a2', 'a3', 'a4', 'a6'], min: 6 * MIN, ptsFor: 0, ptsAgainst: 2, plusMinus: -2, per40: (-2 / 6) * 40 },
      { players: ['a1', 'a2', 'a3', 'a4', 'a5'], min: 4 * MIN, ptsFor: 4, ptsAgainst: 0, plusMinus: 4, per40: (4 / 4) * 40 },
    ]);
  });

  test('team B played one unit all period', () => {
    expect(l.B).toEqual([{ players: ['b1', 'b2', 'b3', 'b4', 'b5'], min: 10 * MIN, ptsFor: 2, ptsAgainst: 4, plusMinus: -2, per40: (-2 / 10) * 40 }]);
  });
});

describe('on/off on the hand-verified game', () => {
  const o = onOff(fixture());
  const of = (id: string) => o.find((x) => x.playerId === id)!;

  test('a5 on for the first 4 minutes, off for the last 6', () => {
    expect(of('a5').on).toEqual({ min: 4 * MIN, ptsFor: 4, ptsAgainst: 0, plusMinus: 4, per40: 40 });
    expect(of('a5').off).toEqual({ min: 6 * MIN, ptsFor: 0, ptsAgainst: 2, plusMinus: -2, per40: (-2 / 6) * 40 });
  });

  test('never off the floor: off has no minutes and no rate', () => {
    expect(of('a1').off).toEqual({ min: 0, ptsFor: 0, ptsAgainst: 0, plusMinus: 0, per40: null });
  });

  test('never played: everything is off', () => {
    expect(of('a7').on.min).toBe(0);
    expect(of('a7').off.min).toBe(10 * MIN);
  });
});

describe('properties on random logs', () => {
  const total = (log: Parameters<typeof walk>[0]) => [...walk(log)].reduce((n, s) => n + s.elapsed, 0);

  test('each team: lineup minutes add up to the time played; lineup +/- to the score margin', () => {
    fc.assert(
      fc.property(arbGameLog, (log) => {
        const l = lineups(log);
        const score = replay(log).score;
        for (const t of ['A', 'B'] as const) {
          expect(l[t].reduce((n, u) => n + u.min, 0)).toBe(total(log));
          expect(l[t].reduce((n, u) => n + u.plusMinus, 0)).toBe(t === 'A' ? score.A - score.B : score.B - score.A);
        }
      }),
    );
  });

  test('every player: on + off = the whole game', () => {
    fc.assert(
      fc.property(arbGameLog, (log) => {
        const t = total(log);
        for (const p of onOff(log)) expect(p.on.min + p.off.min).toBe(t);
      }),
    );
  });
});
