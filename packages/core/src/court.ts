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

/**
 * 12 shot sections: NBA-style basic zone (restricted area, paint, mid-range, corner 3,
 * above-the-break 3) crossed with left / centre / right area, on FIBA lines. Left and right are
 * as drawn: baseline at the bottom of the screen, x = 0 on the left.
 */
export const ZONES = [
  { id: 'restricted', label: 'Restricted area', value: 2 },
  { id: 'paint', label: 'Paint', value: 2 },
  { id: 'midLeftBaseline', label: 'Left baseline', value: 2 },
  { id: 'midLeftWing', label: 'Left wing', value: 2 },
  { id: 'midTop', label: 'Top of key', value: 2 },
  { id: 'midRightWing', label: 'Right wing', value: 2 },
  { id: 'midRightBaseline', label: 'Right baseline', value: 2 },
  { id: 'corner3Left', label: 'Left corner 3', value: 3 },
  { id: 'wing3Left', label: 'Left wing 3', value: 3 },
  { id: 'top3', label: 'Top 3', value: 3 },
  { id: 'wing3Right', label: 'Right wing 3', value: 3 },
  { id: 'corner3Right', label: 'Right corner 3', value: 3 },
] as const;
export type ShotZone = (typeof ZONES)[number]['id'];

/** NBA basic zones, for the grouped table. */
export type ZoneGroup = 'restricted' | 'paint' | 'midRange' | 'corner3' | 'aboveBreak3';
export function zoneGroup(z: ShotZone): ZoneGroup {
  if (z === 'restricted' || z === 'paint') return z;
  if (z.startsWith('mid')) return 'midRange';
  return z.startsWith('corner') ? 'corner3' : 'aboveBreak3';
}

const RESTRICTED = 1.25; // FIBA no-charge semicircle radius
const KEY_HALF_WIDTH = 2.45; // key is 4.9 m wide
const FT_LINE = 5.8; // key depth from the baseline
// Area cut by angle from the basket (0 deg = along the baseline to the right): side < 30,
// wing 30-78, centre 78-102, mirrored on the left.
const SIDE = 30;
const CENTRE = 78;

export function shotZone(x: number, y: number): ShotZone {
  const dx = (x - 0.5) * WIDTH;
  const ym = y * HALF;
  const dy = ym - BASKET_Y;
  const left = dx < 0;
  const angle = dy <= 0 ? 0 : (Math.atan2(dy, Math.abs(dx)) * 180) / Math.PI; // 0..90 from the baseline, per side
  const area = angle < SIDE ? 'side' : angle < CENTRE ? 'wing' : 'centre';

  if (shotValue(x, y) === 3) {
    if (ym <= CORNER_Y) return left ? 'corner3Left' : 'corner3Right';
    return area === 'centre' ? 'top3' : left ? 'wing3Left' : 'wing3Right';
  }
  if (Math.hypot(dx, dy) <= RESTRICTED) return 'restricted';
  if (Math.abs(dx) <= KEY_HALF_WIDTH && ym <= FT_LINE) return 'paint';
  if (area === 'centre') return 'midTop';
  if (area === 'side') return left ? 'midLeftBaseline' : 'midRightBaseline';
  return left ? 'midLeftWing' : 'midRightWing';
}
