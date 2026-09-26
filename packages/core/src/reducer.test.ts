import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { GameEvent } from './events';
import { apply, initialState, replay, type GameState } from './reducer';
import { teamFoulCount } from './validate';
import { FIBA, NBA } from './rules';
import { arbGameLog, ev, gameStart, periodStart } from './test-helpers';

const run = (...events: GameEvent[]) => events.reduce(apply, initialState);
const live = (...events: GameEvent[]) => run(gameStart(), periodStart(), ...events);

describe('game control', () => {
  test('initial state is pregame with no score', () => {
    expect(initialState.phase).toBe('pregame');
    expect(initialState.score).toEqual({ A: 0, B: 0 });
  });

  test('gameStart loads rules, roster and settings', () => {
    const s = run(gameStart(NBA, true));
    expect(s.rules).toEqual(NBA);
    expect(s.shotLocations).toBe(true);
    expect(s.roster.a1).toBe('A');
    expect(s.roster.b8).toBe('B');
    expect(s.phase).toBe('pregame');
  });

  test('periodStart sets lineups, period, full clock and goes live', () => {
    const s = live();
    expect(s.onFloor).toEqual({ A: ['a1', 'a2', 'a3', 'a4', 'a5'], B: ['b1', 'b2', 'b3', 'b4', 'b5'] });
    expect(s.period).toBe(1);
    expect(s.phase).toBe('live');
    expect(s.clock).toEqual({ running: false, gameClock: 600_000, wallClock: expect.any(Number) });
  });

  test('clockStart and clockStop record the game clock and wall clock', () => {
    const s1 = live(ev('clockStart', {}, { gameClock: 600_000, wallClock: 1000 }));
    expect(s1.clock).toEqual({ running: true, gameClock: 600_000, wallClock: 1000 });
    const s2 = apply(s1, ev('clockStop', {}, { gameClock: 590_000, wallClock: 11_000 }));
    expect(s2.clock).toEqual({ running: false, gameClock: 590_000, wallClock: 11_000 });
  });

  test('periodEnd stops the clock and goes to break', () => {
    const s = live(ev('clockStart', {}), ev('periodEnd', {}, { gameClock: 0 }));
    expect(s.phase).toBe('break');
    expect(s.clock.running).toBe(false);
    expect(s.clock.gameClock).toBe(0);
  });

  test('gameEnd goes final', () => {
    expect(live(ev('gameEnd', {})).phase).toBe('final');
  });

  test('timeout counts per team per period', () => {
    const s = live(ev('timeout', { team: 'A' }), ev('timeout', { team: 'A' }), ev('timeout', { team: 'B' }));
    expect(s.timeouts).toEqual({ A: { 1: 2 }, B: { 1: 1 } });
  });

  test('possessionArrow sets the arrow', () => {
    expect(live(ev('possessionArrow', { team: 'B' })).arrow).toBe('B');
  });

  test('jumpBall changes no state', () => {
    const before = live();
    expect(apply(before, ev('jumpBall', { wonBy: 'A' }))).toEqual(before);
  });
});

describe('scoring', () => {
  test('made 2 and 3 score for the shooter team', () => {
    const s = live(
      ev('shot', { shooter: 'a1', value: 2, made: true }),
      ev('shot', { shooter: 'b2', value: 3, made: true }),
    );
    expect(s.score).toEqual({ A: 2, B: 3 });
  });

  test('missed shot scores nothing and makes the ball reboundable', () => {
    const s = live(ev('shot', { shooter: 'a1', value: 3, made: false }));
    expect(s.score).toEqual({ A: 0, B: 0 });
    expect(s.reboundable).toBe(true);
  });

  test('uses rule set point values', () => {
    const rules = { ...FIBA, points: { freeThrow: 1, two: 2, three: 4 } };
    const s = run(gameStart(rules), periodStart(1, rules), ev('shot', { shooter: 'a1', value: 3, made: true }));
    expect(s.score.A).toBe(4);
  });

  test('made free throw scores 1', () => {
    const s = live(ev('freeThrow', { shooter: 'b1', made: true, attempt: 1, of: 1 }));
    expect(s.score.B).toBe(1);
  });

  test('missed last free throw is reboundable, missed first is not', () => {
    expect(live(ev('freeThrow', { shooter: 'a1', made: false, attempt: 1, of: 2 })).reboundable).toBe(false);
    expect(live(ev('freeThrow', { shooter: 'a1', made: false, attempt: 2, of: 2 })).reboundable).toBe(true);
  });

  test('rebound and turnover end the reboundable state', () => {
    const miss = ev('shot', { shooter: 'a1', value: 2, made: false });
    expect(live(miss, ev('rebound', { team: 'B', player: 'b1', kind: 'defensive' })).reboundable).toBe(false);
    expect(live(miss, ev('turnover', { team: 'A', kind: 'shotClock' })).reboundable).toBe(false);
  });
});

describe('substitution', () => {
  test('swaps players in one event', () => {
    const s = live(ev('substitution', { team: 'A', out: ['a1', 'a2'], in: ['a6', 'a7'] }));
    expect(s.onFloor.A).toEqual(['a3', 'a4', 'a5', 'a6', 'a7']);
    expect(s.onFloor.B).toEqual(['b1', 'b2', 'b3', 'b4', 'b5']);
  });
});

describe('fouls', () => {
  const personal = (player: string) =>
    ev('foul', { team: 'B', offender: 'player', player, kind: 'personal', fouled: 'a1', freeThrows: 0 });

  test('player foul adds a personal foul and a team foul', () => {
    const s = live(personal('b1'), personal('b1'), personal('b2'));
    expect(s.personalFouls).toEqual({ b1: 2, b2: 1 });
    expect(s.teamFouls).toEqual({ A: {}, B: { 1: 3 } });
  });

  test('coach technical adds no personal or team foul', () => {
    const s = live(ev('foul', { team: 'B', offender: 'coach', kind: 'technical', freeThrows: 1 }));
    expect(s.personalFouls).toEqual({});
    expect(s.teamFouls.B).toEqual({});
  });

  test('NBA: offensive foul is not a team foul', () => {
    const s = run(
      gameStart(NBA),
      periodStart(1, NBA),
      ev('foul', { team: 'A', offender: 'player', player: 'a1', kind: 'offensive', fouled: 'b1', freeThrows: 0 }),
    );
    expect(s.personalFouls.a1).toBe(1);
    expect(s.teamFouls.A).toEqual({});
  });

  test('foul with free throws queues them for the fouled player', () => {
    const s = live(ev('foul', { team: 'B', offender: 'player', player: 'b1', kind: 'shooting', fouled: 'a1', freeThrows: 2 }));
    expect(s.freeThrowQueue).toEqual([{ team: 'A', shooter: 'a1', next: 1, of: 2 }]);
  });

  test('technical queues free throws for any player of the other team', () => {
    const s = live(ev('foul', { team: 'B', offender: 'bench', kind: 'technical', freeThrows: 1 }));
    expect(s.freeThrowQueue).toEqual([{ team: 'A', shooter: null, next: 1, of: 1 }]);
  });

  test('free throws advance and clear the queue', () => {
    const foul = ev('foul', { team: 'B', offender: 'player', player: 'b1', kind: 'shooting', fouled: 'a1', freeThrows: 2 });
    const s1 = live(foul, ev('freeThrow', { shooter: 'a1', made: true, attempt: 1, of: 2 }));
    expect(s1.freeThrowQueue).toEqual([{ team: 'A', shooter: 'a1', next: 2, of: 2 }]);
    const s2 = apply(s1, ev('freeThrow', { shooter: 'a1', made: true, attempt: 2, of: 2 }));
    expect(s2.freeThrowQueue).toEqual([]);
    expect(s2.score.A).toBe(2);
  });

  test('teamFoulCount: FIBA overtime continues the 4th period count, NBA resets', () => {
    const foulIn = (period: number) =>
      ev('foul', { team: 'A', offender: 'player', player: 'a1', kind: 'personal', fouled: 'b1', freeThrows: 0 }, { period });
    const fiba = run(gameStart(FIBA), periodStart(4), foulIn(4), foulIn(4), periodStart(5), foulIn(5));
    expect(teamFoulCount(fiba, 'A')).toBe(3);
    const nba = run(gameStart(NBA), periodStart(4, NBA), foulIn(4), foulIn(4), periodStart(5, NBA), foulIn(5));
    expect(teamFoulCount(nba, 'A')).toBe(1);
  });
});

describe('session events', () => {
  test('role claim, transfer and release', () => {
    const s1 = run(ev('roleClaim', { role: 'teamA' }, { deviceId: 'd1' }));
    expect(s1.roles).toEqual({ teamA: 'd1' });
    const s2 = apply(s1, ev('roleTransfer', { role: 'teamA', toDeviceId: 'd2' }, { deviceId: 'd1' }));
    expect(s2.roles).toEqual({ teamA: 'd2' });
    const s3 = apply(s2, ev('roleRelease', { role: 'teamA' }, { deviceId: 'd2' }));
    expect(s3.roles).toEqual({});
  });

  test('a clock role claim is remembered for data quality', () => {
    expect(run(ev('roleClaim', { role: 'clock' })).clockRoleSeen).toBe(true);
  });

  test('adminLock locks the game', () => {
    expect(live(ev('adminLock', {})).locked).toBe(true);
  });
});

describe('purity', () => {
  test('apply never mutates its input state', () => {
    fc.assert(
      fc.property(arbGameLog, (log) => {
        let s: GameState = initialState;
        for (const e of log) {
          const snapshot = structuredClone(s);
          const next = apply(s, e);
          expect(s).toEqual(snapshot);
          s = next;
        }
      }),
    );
  });

  test('replaying the same ordered log always yields identical state', () => {
    fc.assert(
      fc.property(arbGameLog, (log) => {
        expect(replay(log)).toEqual(replay(structuredClone(log)));
      }),
    );
  });

  test('replay ignores duplicate event ids', () => {
    fc.assert(
      fc.property(arbGameLog, (log) => {
        expect(replay(log.flatMap((e) => [e, e]))).toEqual(replay(log));
      }),
    );
  });
});
