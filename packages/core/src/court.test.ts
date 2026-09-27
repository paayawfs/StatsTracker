import { describe, expect, test } from 'vitest';
import { inPaint, shotValue, shotZone, ZONES, zoneGroup } from './court';

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

describe('shotZone: 12 sections on painted lines (key, no-charge arc, FT line and lane lines extended, arc)', () => {
  test.each([
    ['at the basket', 7.5, 1.575, 'restricted'],
    ['1.1 m out, inside the no-charge arc', 7.5, 2.7, 'restricted'],
    ['in the key', 8.5, 4.5, 'paint'],
    ['on the free-throw line', 7.5, 5.7, 'paint'],
    ['baseline jumper, left of the key', 3, 1, 'midLeftBaseline'],
    ['baseline jumper, right of the key', 12, 1, 'midRightBaseline'],
    ['left wing two (above FT line extended)', 4, 6.5, 'midLeftWing'],
    ['right wing two', 11, 6.5, 'midRightWing'],
    ['left wing two, below FT line but above the corner line', 3, 4, 'midLeftWing'],
    ['top of the key two (between the lane lines extended)', 7.5, 7.8, 'midTop'],
    ['left corner three', 0.5, 1, 'corner3Left'],
    ['right corner three', 14.6, 1, 'corner3Right'],
    ['left wing three', 2, 7, 'wing3Left'],
    ['right wing three', 13, 7, 'wing3Right'],
    ['top of the key three', 7.5, 10, 'top3'],
    ['top three, slightly left but inside the lane lines extended', 6, 9, 'top3'],
    ['half court heave', 7.5, 13.9, 'top3'],
  ])('%s', (_, xm, ym, zone) => {
    expect(shotZone(...m(xm, ym))).toBe(zone);
  });

  test('every section has a label, a point value consistent with shotValue, and a group', () => {
    expect(ZONES).toHaveLength(12);
    for (const [xm, ym] of [[7.5, 1.575], [8.5, 4.5], [3, 1], [4, 6.5], [7.5, 7.8], [0.5, 1], [2, 7], [7.5, 10]] as const) {
      const [x, y] = m(xm, ym);
      const z = ZONES.find((zz) => zz.id === shotZone(x, y))!;
      expect(z.value).toBe(shotValue(x, y));
      expect(z.label.length).toBeGreaterThan(0);
    }
    expect(zoneGroup('restricted')).toBe('restricted');
    expect(zoneGroup('paint')).toBe('paint');
    expect(zoneGroup('midLeftWing')).toBe('midRange');
    expect(zoneGroup('corner3Right')).toBe('corner3');
    expect(zoneGroup('top3')).toBe('aboveBreak3');
  });

  test('points in the paint come from the restricted area and the paint', () => {
    expect(inPaint('restricted')).toBe(true);
    expect(inPaint('paint')).toBe(true);
    expect(inPaint('midTop')).toBe(false);
  });
});
