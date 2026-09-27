import { shotZone, ZONES } from '@stats/core';
import { describe, expect, test } from 'vitest';
import { snapToSection, toCourt, ZONE_LABEL_AT } from './geometry';

describe('court geometry', () => {
  test('every section label sits inside its own section', () => {
    for (const z of ZONES) {
      const [sx, sy] = ZONE_LABEL_AT[z.id];
      expect(shotZone(sx / 150, 1 - sy / 140), z.id).toBe(z.id);
    }
  });

  test('screen <-> normalised court coordinates', () => {
    expect(toCourt(75, 124.25)).toEqual({ x: 0.5, y: expect.closeTo(0.1125, 6) });
    expect(toCourt(0, 140)).toEqual({ x: 0, y: 0 });
  });
});

describe('snapToSection', () => {
  test('a tap anywhere snaps to its own section, at that section\'s reference point', () => {
    for (let x = 0.01; x < 1; x += 0.02) {
      for (let y = 0.01; y < 1; y += 0.02) {
        const s = snapToSection(x, y);
        expect(shotZone(s.x, s.y)).toBe(shotZone(x, y));
        expect(s.zone).toBe(shotZone(x, y));
      }
    }
  });
});
