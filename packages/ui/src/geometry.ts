import { shotZone, type ShotZone } from '@stats/core';

/**
 * FIBA half court in SVG units: 10 units per metre, 150 x 140, baseline at the bottom (y = 140).
 * Normalised court coordinates (what events store) are x 0..1 left to right, y 0..1 from the
 * baseline to half court.
 */
export const W = 150;
export const H = 140;
export const BASKET = { x: 75, y: 124.25 };
export const ARC_R = 67.5;
export const CORNER_Y = 110.1; // where the straight corner lines meet the arc
export const RESTRICTED_R = 12.5;
export const KEY = { x: 50, y: 82, w: 50, h: 58 };
/** Section rings (8 ft and 16 ft from the basket), in SVG units. */
export const RIM_RING = 24.4;
export const SHORT_RING = 48.8;

export const toCourt = (sx: number, sy: number) => ({ x: sx / W, y: (H - sy) / H });
export const toScreen = (x: number, y: number) => ({ sx: x * W, sy: H - y * H });

/** Point at `deg` (0 = along the baseline to the right, 90 = straight up court) far from the basket. */
export const ray = (deg: number, r = 400) => {
  const t = (deg * Math.PI) / 180;
  return `${(BASKET.x + r * Math.cos(t)).toFixed(2)} ${(BASKET.y - r * Math.sin(t)).toFixed(2)}`;
};
export const wedge = (from: number, to: number) => `M${BASKET.x} ${BASKET.y} L${ray(from)} L${ray((from + to) / 2)} L${ray(to)} Z`;

/** Inside the three-point line (closed along the baseline). */
export const INSIDE_ARC = `M9 ${H} V${CORNER_Y} A${ARC_R} ${ARC_R} 0 0 1 141 ${CORNER_Y} V${H} Z`;

/** Where each section's label (or heat value) is drawn; inside the section (tested). */
export const ZONE_LABEL_AT: Record<ShotZone, [number, number]> = {
  rim: [75, 118],
  shortMid: [75, 88],
  midLeftBaseline: [22, 130],
  midRightBaseline: [128, 130],
  midLeftWing: [40, 80],
  midRightWing: [110, 80],
  midTop: [75, 66],
  corner3Left: [4.5, 126],
  corner3Right: [145.5, 126],
  wing3Left: [18, 62],
  wing3Right: [132, 62],
  top3: [75, 35],
};

/**
 * Scorers tap a section, not an exact spot: any tap snaps to its section's reference point (the
 * label point, tested to lie inside the section). Returned in normalised court coordinates.
 */
export function snapToSection(x: number, y: number): { x: number; y: number; zone: ShotZone } {
  const zone = shotZone(x, y);
  const [sx, sy] = ZONE_LABEL_AT[zone];
  return { ...toCourt(sx, sy), zone };
}
