import { describe, expect, test } from 'vitest';
import { minutes, pct, signed } from './format';

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
