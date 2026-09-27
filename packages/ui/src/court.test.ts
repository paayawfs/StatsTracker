import { shotZone, ZONES } from '@stats/core';
import { describe, expect, test } from 'vitest';
import { toCourt, ZONE_LABEL_AT } from './geometry';

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
