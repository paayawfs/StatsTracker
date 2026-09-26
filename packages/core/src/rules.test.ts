import { describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { FIBA, NBA, RuleSetSchema, periodLength, timeoutsAllowed } from './rules';

describe('rule set presets', () => {
  test('FIBA and NBA presets are valid rule sets', () => {
    expect(v.parse(RuleSetSchema, FIBA)).toEqual(FIBA);
    expect(v.parse(RuleSetSchema, NBA)).toEqual(NBA);
  });

  test('FIBA: 4 x 10 min, 5 fouls, bonus after 4 team fouls', () => {
    expect(FIBA.periods).toBe(4);
    expect(FIBA.periodLengthMs).toBe(600_000);
    expect(FIBA.personalFoulLimit).toBe(5);
    expect(FIBA.teamFoulBonus.threshold).toBe(4);
  });

  test('NBA: 4 x 12 min, 6 fouls', () => {
    expect(NBA.periodLengthMs).toBe(720_000);
    expect(NBA.personalFoulLimit).toBe(6);
  });
});

describe('rule set validation', () => {
  const bad = (patch: object) => v.safeParse(RuleSetSchema, { ...FIBA, ...patch }).success;

  test.each([
    ['zero periods', { periods: 0 }],
    ['negative foul limit', { personalFoulLimit: -1 }],
    ['fractional period length', { periodLengthMs: 1.5 }],
    ['zero period length', { periodLengthMs: 0 }],
    ['missing points', { points: undefined }],
    ['timeout window outside periods', { timeouts: [{ periods: [5], count: 2 }] }],
  ])('rejects %s', (_, patch) => {
    expect(bad(patch)).toBe(false);
  });
});

describe('rule helpers', () => {
  test('periodLength uses overtime length after regulation', () => {
    expect(periodLength(FIBA, 4)).toBe(600_000);
    expect(periodLength(FIBA, 5)).toBe(300_000);
  });

  test('timeoutsAllowed: FIBA 2 first half, 3 second half, 1 per overtime', () => {
    expect(timeoutsAllowed(FIBA, 1)).toEqual({ periods: [1, 2], count: 2 });
    expect(timeoutsAllowed(FIBA, 4)).toEqual({ periods: [3, 4], count: 3 });
    expect(timeoutsAllowed(FIBA, 6)).toEqual({ periods: [6], count: 1 });
  });

  test('timeoutsAllowed: NBA 7 per game', () => {
    expect(timeoutsAllowed(NBA, 3)).toEqual({ periods: [1, 2, 3, 4], count: 7 });
  });
});
