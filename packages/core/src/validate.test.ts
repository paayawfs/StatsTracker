import { describe, expect, test } from 'vitest';
import type { EventOf, GameEvent } from './events';
import { apply, initialState } from './reducer';
import { FIBA, NBA } from './rules';
import { ev, gameStart, periodStart } from './test-helpers';
import { dataQuality } from './validate';

const run = (...events: GameEvent[]) => events.reduce(apply, initialState);
const codes = (...events: GameEvent[]) => run(gameStart(), periodStart(), ...events).flags.map((f) => f.code);
const foul = (p: Partial<EventOf<'foul'>['payload']>) =>
  ev('foul', { team: 'B', offender: 'player', player: 'b1', kind: 'personal', fouled: 'a1', freeThrows: 0, ...p });

describe('a clean game raises no flags', () => {
  test('full sequence of legal events', () => {
    const s = run(
      ev('roleClaim', { role: 'single' }, { period: 0, gameClock: 0 }),
      gameStart(FIBA, true),
      periodStart(),
      ev('clockStart', {}),
      ev('shot', { shooter: 'a1', value: 3, made: true, assist: 'a2', x: 0.1, y: 0.9 }),
      ev('shot', { shooter: 'b1', value: 2, made: false, block: 'a3', x: 0.5, y: 0.5 }),
      ev('rebound', { team: 'A', player: 'a4', kind: 'defensive' }),
      ev('turnover', { team: 'A', player: 'a4', kind: 'badPass', steal: 'b2' }),
      ev('shot', { shooter: 'b2', value: 2, made: false, x: 0.5, y: 0.5 }),
      ev('rebound', { team: 'B', kind: 'offensive' }),
      foul({ kind: 'shooting', freeThrows: 2 }),
      ev('clockStop', {}),
      ev('freeThrow', { shooter: 'a1', made: true, attempt: 1, of: 2 }),
      ev('substitution', { team: 'A', out: ['a5'], in: ['a6'] }),
      ev('freeThrow', { shooter: 'a1', made: false, attempt: 2, of: 2 }),
      ev('rebound', { team: 'B', player: 'b3', kind: 'defensive' }),
      ev('timeout', { team: 'B' }),
      ev('foul', { team: 'A', offender: 'coach', kind: 'technical', freeThrows: 1 }),
      ev('freeThrow', { shooter: 'b4', made: true, attempt: 1, of: 1 }),
      ev('checkpoint', { score: { A: 4, B: 1 } }),
      ev('periodEnd', {}, { gameClock: 0 }),
    );
    expect(s.flags).toEqual([]);
  });
});

describe('each rule flags its violation', () => {
  test('play event before gameStart', () => {
    expect(run(ev('shot', { shooter: 'a1', value: 2, made: true })).flags.map((f) => f.code)).toEqual(['no-game-start']);
  });

  test('unknown player', () => {
    expect(codes(ev('shot', { shooter: 'zz', value: 2, made: true }))).toEqual(['unknown-player']);
  });

  test('player not on floor', () => {
    expect(codes(ev('shot', { shooter: 'a8', value: 2, made: true }))).toEqual(['not-on-floor']);
  });

  test('assist from the other team, block from own team', () => {
    expect(codes(ev('shot', { shooter: 'a1', value: 2, made: true, assist: 'b1' }))).toEqual(['wrong-team']);
    expect(codes(ev('shot', { shooter: 'a1', value: 2, made: false, block: 'a2' }))).toEqual(['wrong-team']);
  });

  test('steal from own team', () => {
    expect(codes(ev('turnover', { team: 'A', player: 'a1', kind: 'travelling', steal: 'a2' }))).toEqual(['wrong-team']);
  });

  test('rebound by a player of the other team than stated', () => {
    expect(
      codes(ev('shot', { shooter: 'a1', value: 2, made: false }), ev('rebound', { team: 'A', player: 'b1', kind: 'offensive' })),
    ).toEqual(['wrong-team']);
  });

  test('lineup that is not 5 per team', () => {
    const s = run(gameStart(), ev('periodStart', { lineups: { A: ['a1', 'a2', 'a3', 'a4'], B: ['b1', 'b2', 'b3', 'b4', 'b5'] } }));
    expect(s.flags).toEqual([{ eventId: expect.any(String), code: 'lineup-size', detail: 'A has 4 on floor' }]);
  });

  test('substitution leaving a team short-handed', () => {
    expect(codes(ev('substitution', { team: 'A', out: ['a1'], in: [] }))).toEqual(['lineup-size']);
  });

  test('substitution of a player not on floor, or already on floor', () => {
    expect(codes(ev('substitution', { team: 'A', out: ['a8'], in: ['a7'] }))).toContain('bad-substitution');
    expect(codes(ev('substitution', { team: 'A', out: ['a1'], in: ['a2'] }))).toContain('bad-substitution');
  });

  test('rebound without a preceding miss', () => {
    expect(codes(ev('rebound', { team: 'A', player: 'a1', kind: 'offensive' }))).toEqual(['rebound-without-miss']);
    expect(
      codes(ev('shot', { shooter: 'a1', value: 2, made: true }), ev('rebound', { team: 'B', kind: 'defensive' })),
    ).toEqual(['rebound-without-miss']);
  });

  test('free throw nobody is owed', () => {
    expect(codes(ev('freeThrow', { shooter: 'a1', made: true, attempt: 1, of: 2 }))).toEqual(['unexpected-free-throw']);
  });

  test('free throw out of order', () => {
    expect(
      codes(foul({ kind: 'shooting', freeThrows: 2 }), ev('freeThrow', { shooter: 'a1', made: true, attempt: 2, of: 2 })),
    ).toEqual(['free-throw-order']);
  });

  test('free throws not taken before period end', () => {
    expect(codes(foul({ kind: 'shooting', freeThrows: 2 }), ev('periodEnd', {}, { gameClock: 0 }))).toEqual([
      'free-throws-unfinished',
    ]);
  });

  test('foul free-throw count must match the rule set', () => {
    // Not in bonus: a personal foul gives no free throws.
    expect(codes(foul({ freeThrows: 2 }))).toEqual(['free-throw-count']);
    // In bonus after 4 team fouls: the 5th must give 2.
    const four = [1, 2, 3, 4].map(() => foul({ player: 'b2' }));
    expect(codes(...four, foul({ freeThrows: 0 }))).toEqual(['free-throw-count']);
    expect(codes(...four, foul({ freeThrows: 2 }))).toEqual([]);
    // Shooting foul needs at least 1, offensive gives none, technical per rule set.
    expect(codes(foul({ kind: 'shooting', freeThrows: 0 }))).toEqual(['free-throw-count']);
    expect(codes(foul({ kind: 'offensive', freeThrows: 1 }))).toEqual(['free-throw-count']);
    expect(codes(foul({ kind: 'technical', freeThrows: 2 }))).toEqual(['free-throw-count']);
  });

  test('NBA overtime bonus starts at the 4th team foul', () => {
    const nbaFoul = () => ev('foul', { team: 'B', offender: 'player', player: 'b2', kind: 'personal', fouled: 'a1', freeThrows: 0 }, { period: 5 });
    const s = run(gameStart(NBA), periodStart(5, NBA), nbaFoul(), nbaFoul(), nbaFoul(), nbaFoul());
    expect(s.flags.map((f) => f.code)).toEqual(['free-throw-count']);
  });

  test('fouled-out player keeps playing', () => {
    const five = [1, 2, 3, 4, 5].map(() => foul({ player: 'b1', fouled: 'a1' }));
    const s = run(gameStart(), periodStart(), ...five, ev('shot', { shooter: 'b1', value: 2, made: true }));
    expect(s.flags.map((f) => f.code)).toContain('fouled-out');
    expect(s.flags.at(-1)).toMatchObject({ code: 'fouled-out', detail: 'b1' });
  });

  test('fouled-out player subbed back in', () => {
    const five = [1, 2, 3, 4, 5].map(() => foul({ player: 'b1' }));
    const s = run(
      gameStart(),
      periodStart(),
      ...five,
      ev('substitution', { team: 'B', out: ['b1'], in: ['b6'] }),
      ev('substitution', { team: 'B', out: ['b6'], in: ['b1'] }),
    );
    expect(s.flags.at(-1)).toMatchObject({ code: 'fouled-out', detail: 'b1' });
  });

  test('too many timeouts in a window', () => {
    const t = () => ev('timeout', { team: 'A' });
    expect(codes(t(), t())).toEqual([]);
    expect(codes(t(), t(), t())).toEqual(['timeouts-exceeded']);
  });

  test('claiming a role another device holds', () => {
    const s = run(ev('roleClaim', { role: 'teamA' }, { deviceId: 'd1' }), ev('roleClaim', { role: 'teamA' }, { deviceId: 'd2' }));
    expect(s.flags.map((f) => f.code)).toEqual(['role-held']);
    expect(s.roles.teamA).toBe('d1');
  });

  test('checkpoint score differs from computed score', () => {
    expect(codes(ev('checkpoint', { score: { A: 2, B: 0 } }))).toEqual(['score-mismatch']);
  });

  test('shot without location when locations are on', () => {
    const s = run(gameStart(FIBA, true), periodStart(), ev('shot', { shooter: 'a1', value: 2, made: true }));
    expect(s.flags.map((f) => f.code)).toEqual(['missing-location']);
  });

  test('non-admin correction after lock', () => {
    expect(codes(ev('adminLock', {}), ev('void', { targetId: 'x' }, { role: 'teamA' }))).toEqual(['locked-correction']);
    expect(codes(ev('adminLock', {}), ev('void', { targetId: 'x' }, { role: 'admin' }))).toEqual([]);
  });
});

describe('dataQuality', () => {
  test('summarises clock role, missing locations and mismatches', () => {
    const s = run(
      ev('roleClaim', { role: 'clock' }),
      gameStart(FIBA, true),
      periodStart(),
      ev('shot', { shooter: 'a1', value: 2, made: true }),
      ev('checkpoint', { score: { A: 0, B: 0 } }),
    );
    expect(dataQuality(s)).toEqual({ clockRole: true, missingLocations: 1, scoreMismatches: 1, flags: 2 });
  });
});
