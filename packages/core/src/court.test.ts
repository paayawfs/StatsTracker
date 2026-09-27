import { describe, expect, test } from 'vitest';
import { shotValue, shotZone } from './court';

// Half court, normalised: x 0..1 across the 15 m width, y 0..1 from the baseline to half court (14 m).
const m = (xm: number, ym: number) => [xm / 15, ym / 14] as const;

describe('shotValue (FIBA geometry)', () => {
  test('under the basket is a 2', () => {
    expect(shotValue(...m(7.5, 1.575))).toBe(2);
  });
  test('top of the key just inside the arc is a 2', () => {
    expect(shotValue(...m(7.5, 1.575 + 6.6))).toBe(2);
  });
  test('top of the key beyond the arc is a 3', () => {
    expect(shotValue(...m(7.5, 1.575 + 6.9))).toBe(3);
  });
  test('corner three: within 0.9 m of the sideline, near the baseline', () => {
    expect(shotValue(...m(0.5, 1))).toBe(3);
    expect(shotValue(...m(14.5, 1))).toBe(3);
  });
  test('baseline just inside the corner line is a 2', () => {
    expect(shotValue(...m(1.2, 1))).toBe(2);
  });
  test('half court is a 3', () => {
    expect(shotValue(...m(7.5, 13.9))).toBe(3);
  });
});

describe('shotZone', () => {
  test('paint: inside the key', () => {
    expect(shotZone(...m(7.5, 1.575))).toBe('paint');
    expect(shotZone(...m(9.8, 5.5))).toBe('paint');
  });
  test('mid-range: a 2 outside the key', () => {
    expect(shotZone(...m(7.5, 1.575 + 6.0))).toBe('midRange');
    expect(shotZone(...m(11, 1))).toBe('midRange');
  });
  test('corner 3 and above-the-break 3', () => {
    expect(shotZone(...m(0.5, 1))).toBe('corner3');
    expect(shotZone(...m(7.5, 10))).toBe('aboveBreak3');
  });
});
