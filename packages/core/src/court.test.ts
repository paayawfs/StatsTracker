import { describe, expect, test } from 'vitest';
import { shotValue, shotZone, ZONES, zoneGroup } from './court';

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

describe('shotZone: 12 sections (NBA basic zone x left/centre/right area, FIBA lines)', () => {
  test.each([
    ['at the basket', 7.5, 1.575, 'restricted'],
    ['1.2 m from the basket', 7.5, 2.7, 'restricted'],
    ['in the key, outside the restricted area', 8.5, 4.5, 'paint'],
    ['baseline jumper, left', 3, 1, 'midLeftBaseline'],
    ['baseline jumper, right', 12, 1, 'midRightBaseline'],
    ['elbow-ish wing, left', 4.5, 5.5, 'midLeftWing'],
    ['wing, right', 10.8, 5.5, 'midRightWing'],
    ['top of the key, inside the arc', 7.5, 7.8, 'midTop'],
    ['left corner three', 0.5, 1, 'corner3Left'],
    ['right corner three', 14.6, 1, 'corner3Right'],
    ['left wing three', 2, 7, 'wing3Left'],
    ['right wing three', 13, 7, 'wing3Right'],
    ['top three', 7.5, 10, 'top3'],
    ['half court heave', 7.5, 13.9, 'top3'],
  ])('%s -> %s', (_, xm, ym, zone) => {
    expect(shotZone(...m(xm, ym))).toBe(zone);
  });

  test('every section has a label, a point value consistent with shotValue, and a group', () => {
    expect(ZONES).toHaveLength(12);
    for (const [xm, ym] of [[7.5, 1.575], [8.5, 4.5], [3, 1], [4.5, 5.5], [7.5, 7.8], [0.5, 1], [2, 7], [7.5, 10]] as const) {
      const [x, y] = m(xm, ym);
      const z = ZONES.find((zz) => zz.id === shotZone(x, y))!;
      expect(z.value).toBe(shotValue(x, y));
      expect(z.label.length).toBeGreaterThan(0);
    }
    expect(zoneGroup('midLeftWing')).toBe('midRange');
    expect(zoneGroup('corner3Right')).toBe('corner3');
    expect(zoneGroup('top3')).toBe('aboveBreak3');
  });
});
