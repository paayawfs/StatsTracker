// FIBA court. Coordinates are normalised to the half court: x 0..1 across the 15 m width,
// y 0..1 from the baseline (0) to half court (14 m).
const WIDTH = 15;
const HALF = 14;
const BASKET_Y = 1.575;
const ARC = 6.75;
const CORNER_X = 0.9; // three-point line distance from the sideline in the corners
const CORNER_Y = 2.99; // where the straight corner line meets the arc

// ponytail: FIBA lines only. NBA lines differ (7.24 m / 6.71 m); the scorer can flip the value.
export function shotValue(x: number, y: number): 2 | 3 {
  const dx = (x - 0.5) * WIDTH;
  const ym = y * HALF;
  if (ym <= CORNER_Y) return Math.abs(dx) >= WIDTH / 2 - CORNER_X ? 3 : 2;
  return Math.hypot(dx, ym - BASKET_Y) > ARC ? 3 : 2;
}

export type ShotZone = 'paint' | 'midRange' | 'corner3' | 'aboveBreak3';
const KEY_HALF_WIDTH = 2.45; // FIBA restricted area (key) is 4.9 m wide
const FT_LINE = 5.8; // key depth from the baseline

export function shotZone(x: number, y: number): ShotZone {
  const dx = Math.abs((x - 0.5) * WIDTH);
  const ym = y * HALF;
  if (shotValue(x, y) === 3) return ym <= CORNER_Y ? 'corner3' : 'aboveBreak3';
  return dx <= KEY_HALF_WIDTH && ym <= FT_LINE ? 'paint' : 'midRange';
}
