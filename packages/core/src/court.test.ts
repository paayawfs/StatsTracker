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

describe('shotZone: 12 sections (distance rings x left/centre/right, FIBA lines)', () => {
  test.each([
    ['at the basket', 7.5, 1.575, 'rim'],
    ['2.3 m from the basket', 7.5, 3.875, 'rim'],
    ['in the key, 3 m out', 8.5, 4.5, 'shortMid'],
    ['free-throw line', 7.5, 5.8, 'shortMid'],
    ['short baseline jumper (4.5 m)', 3, 1, 'shortMid'],
    ['long baseline jumper, left', 2.2, 1, 'midLeftBaseline'],
    ['long baseline jumper, right', 12.8, 1, 'midRightBaseline'],
    ['long wing two, left', 4, 6, 'midLeftWing'],
    ['long wing two, right', 11, 6, 'midRightWing'],
    ['long two, top of the key', 7.5, 7.8, 'midTop'],
    ['left corner three', 0.5, 1, 'corner3Left'],
    ['right corner three', 14.6, 1, 'corner3Right'],
    ['left wing three', 2, 7, 'wing3Left'],
    ['right wing three', 13, 7, 'wing3Right'],
    ['top three', 7.5, 10, 'top3'],
    ['half court heave', 7.5, 13.9, 'top3'],
  ])('%s', (_, xm, ym, zone) => {
    expect(shotZone(...m(xm, ym))).toBe(zone);
  });

  test('every section has a label, a point value consistent with shotValue, and a group', () => {
    expect(ZONES).toHaveLength(12);
    for (const [xm, ym] of [[7.5, 1.575], [8.5, 4.5], [2.2, 1], [4, 6], [7.5, 7.8], [0.5, 1], [2, 7], [7.5, 10]] as const) {
      const [x, y] = m(xm, ym);
      const z = ZONES.find((zz) => zz.id === shotZone(x, y))!;
      expect(z.value).toBe(shotValue(x, y));
      expect(z.label.length).toBeGreaterThan(0);
    }
    expect(zoneGroup('rim')).toBe('rim');
    expect(zoneGroup('shortMid')).toBe('shortMid');
    expect(zoneGroup('midLeftWing')).toBe('longMid');
    expect(zoneGroup('corner3Right')).toBe('corner3');
    expect(zoneGroup('top3')).toBe('aboveBreak3');
  });
});
