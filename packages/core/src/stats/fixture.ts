import { ev, gameStart, periodStart } from '../test-helpers';

export const MIN = 60_000;

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
export const fixture = () => [
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
