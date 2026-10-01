import { describe, expect, test } from 'vitest';
import { heat, minutes, pct, signed } from './format';

describe('format', () => {
  test('minutes as m:ss', () => {
    expect(minutes(0)).toBe('0:00');
    expect(minutes(65_000)).toBe('1:05');
    expect(minutes(600_000)).toBe('10:00');
    expect(minutes(59_999)).toBe('0:59');
  });
  test('shooting percentage', () => {
    expect(pct(0, 0)).toBe('-');
    expect(pct(1, 3)).toBe('33%');
    expect(pct(2, 2)).toBe('100%');
  });
  test('signed numbers for +/-', () => {
    expect(signed(3)).toBe('+3');
    expect(signed(0)).toBe('0');
    expect(signed(-2)).toBe('-2');
    expect(signed(null)).toBe('-');
    expect(signed(4.44, 1)).toBe('+4.4');
  });
});

describe('heat', () => {
  test('no attempts: no colour', () => {
    expect(heat(0, 0)).toBeUndefined();
  });
  test('cold is pale violet, hot is deep violet; more attempts, stronger colour', () => {
    expect(heat(0, 4)).toBe('hsla(270, 60%, 85%, 0.53)');
    expect(heat(4, 4)).toBe('hsla(270, 60%, 40%, 0.53)');
    expect(heat(1, 1)).toBe('hsla(270, 60%, 40%, 0.32)');
    expect(heat(10, 20)).toBe('hsla(270, 60%, 63%, 0.6)');
  });
});
