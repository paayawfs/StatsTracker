import { describe, expect, test } from 'vitest';
import { shotValue } from './court';

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
