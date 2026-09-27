import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { replay } from '../reducer';
import { arbGameLog, ev, gameStart, periodStart } from '../test-helpers';
import { boxScore } from './box';

const MIN = 60_000;

/**
 * Hand-verified fixture: one 10-minute period.
 *   10:00 start, A a1-a5 vs B b1-b5
 *    9:00 a1 3PT made, assist a2                   A 3-0
 *    8:00 b1 2PT missed, blocked by a3; a4 def reb
 *    7:00 a2 turnover (bad pass), steal b2
 *    6:00 b3 shooting foul on a1 -> 2 FT
 *    6:00 a1 FT 1/2 made                            A 4-0
 *    6:00 sub A: a5 out, a6 in (between free throws)
 *    6:00 a1 FT 2/2 missed; team B def reb
 *    5:00 b4 2PT made                               A 4-2
 *    0:00 end of period
 */
const fixture = () => [
  gameStart(),
  periodStart(),
  ev('shot', { shooter: 'a1', value: 3, made: true, assist: 'a2' }, { gameClock: 9 * MIN }),
  ev('shot', { shooter: 'b1', value: 2, made: false, block: 'a3' }, { gameClock: 8 * MIN }),
  ev('rebound', { team: 'A', player: 'a4', kind: 'defensive' }, { gameClock: 8 * MIN }),
  ev('turnover', { team: 'A', player: 'a2', kind: 'badPass', steal: 'b2' }, { gameClock: 7 * MIN }),
  ev('foul', { team: 'B', offender: 'player', player: 'b3', kind: 'shooting', fouled: 'a1', freeThrows: 2 }, { gameClock: 6 * MIN }),
  ev('freeThrow', { shooter: 'a1', made: true, attempt: 1, of: 2 }, { gameClock: 6 * MIN }),
  ev('substitution', { team: 'A', out: ['a5'], in: ['a6'] }, { gameClock: 6 * MIN }),
  ev('freeThrow', { shooter: 'a1', made: false, attempt: 2, of: 2 }, { gameClock: 6 * MIN }),
  ev('rebound', { team: 'B', kind: 'defensive' }, { gameClock: 6 * MIN }),
  ev('shot', { shooter: 'b4', value: 2, made: true }, { gameClock: 5 * MIN }),
  ev('periodEnd', {}, { gameClock: 0 }),
];

describe('boxScore on a hand-verified game', () => {
  const box = boxScore(fixture());
  const line = (id: string) => box.players.find((p) => p.playerId === id)!;

  test('shooting and points', () => {
    expect(line('a1')).toMatchObject({ pts: 4, fgm: 1, fga: 1, p3m: 1, p3a: 1, p2m: 0, p2a: 0, ftm: 1, fta: 2, fd: 1 });
    expect(line('b1')).toMatchObject({ pts: 0, fgm: 0, fga: 1, p2a: 1 });
    expect(line('b4')).toMatchObject({ pts: 2, fgm: 1, fga: 1, p2m: 1, p2a: 1 });
  });

  test('assists, blocks, steals, turnovers, rebounds, fouls', () => {
    expect(line('a2')).toMatchObject({ ast: 1, to: 1 });
    expect(line('a3')).toMatchObject({ blk: 1 });
    expect(line('b2')).toMatchObject({ stl: 1 });
    expect(line('a4')).toMatchObject({ dreb: 1, oreb: 0, reb: 1 });
    expect(line('b3')).toMatchObject({ pf: 1 });
  });

  test('minutes from event clocks (a5 subbed out at 6:00, a6 in)', () => {
    expect(line('a1').min).toBe(10 * MIN);
    expect(line('a5').min).toBe(4 * MIN);
    expect(line('a6').min).toBe(6 * MIN);
    expect(line('a7').min).toBe(0);
  });

  test('plus-minus uses the lineup at each score (sub between free throws)', () => {
    expect(line('a1').plusMinus).toBe(2); // 3 + 1 - 2
    expect(line('a5').plusMinus).toBe(4); // on for the 3 and the first FT
    expect(line('a6').plusMinus).toBe(-2); // on only for b4's basket
    expect(line('b1').plusMinus).toBe(-2);
  });

  test('FIBA efficiency', () => {
    // a1: 4 PTS - 0 missed FG - 1 missed FT = 3
    expect(line('a1').eff).toBe(3);
    // a2: 1 AST - 1 TO = 0
    expect(line('a2').eff).toBe(0);
    // b1: 0 - 1 missed FG = -1
    expect(line('b1').eff).toBe(-1);
  });

  test('team lines include team rebounds and totals', () => {
    expect(box.teams.A).toMatchObject({ pts: 4, fga: 1, fta: 2, ast: 1, to: 1, blk: 1, dreb: 1, teamReb: 0 });
    expect(box.teams.B).toMatchObject({ pts: 2, fga: 2, stl: 1, pf: 1, teamReb: 1, reb: 1 });
  });

  test('every roster player has a line, in roster order', () => {
    expect(box.players.map((p) => p.playerId)).toEqual([...'12345678'].map((n) => `a${n}`).concat([...'12345678'].map((n) => `b${n}`)));
  });
});

describe('boxScore on a live game (no period end yet)', () => {
  test('minutes count up to the latest event', () => {
    const events = fixture().slice(0, 3); // start + a1's three at 9:00
    expect(boxScore(events).players.find((p) => p.playerId === 'a1')!.min).toBe(MIN);
  });
});

describe('boxScore properties on random logs', () => {
  test('team points equal the scoreboard and the sum of player points', () => {
    fc.assert(
      fc.property(arbGameLog, (log) => {
        const box = boxScore(log);
        const score = replay(log).score;
        for (const t of ['A', 'B'] as const) {
          expect(box.teams[t].pts).toBe(score[t]);
          expect(box.players.filter((p) => p.team === t).reduce((n, p) => n + p.pts, 0)).toBe(score[t]);
        }
      }),
    );
  });

  test('team rebounds and turnovers: player sums + team-only = team line', () => {
    fc.assert(
      fc.property(arbGameLog, (log) => {
        const box = boxScore(log);
        for (const t of ['A', 'B'] as const) {
          const players = box.players.filter((p) => p.team === t);
          expect(players.reduce((n, p) => n + p.reb, 0) + box.teams[t].teamReb).toBe(box.teams[t].reb);
          expect(players.reduce((n, p) => n + p.to, 0) + box.teams[t].teamTo).toBe(box.teams[t].to);
        }
      }),
    );
  });
});
