import { ZONES, type ShotZone } from '@stats/core';
import type { ComponentChildren, JSX } from 'preact';
import { ARC_R, BASKET, circle, CORNER_Y, H, INSIDE_ARC, KEY, rect, RESTRICTED_R, toCourt, W, ZONE_LABEL_AT } from './geometry';

export interface CourtProps {
  /** Tap on the court, in normalised court coordinates. */
  onTap?: (x: number, y: number) => void;
  /** Section to highlight (e.g. where the scorer just tapped). */
  highlight?: ShotZone | null;
  /** Fill per section (e.g. a heat map). */
  fills?: Partial<Record<ShotZone, string>>;
  /** Text per section (e.g. "3/7"). */
  labels?: Partial<Record<ShotZone, string>>;
  /** Extra SVG drawn on top, in court units (150 x 140, baseline at the bottom). */
  children?: ComponentChildren;
  class?: string;
  testId?: string;
  /** Unique per page so mask ids don't collide when two courts are shown. */
  id?: string;
}

const LANE_L = KEY.x; // left lane line (extended up the floor)
const LANE_R = KEY.x + KEY.w;
const FT = KEY.y; // free-throw line (extended to the arc)

/**
 * Each section = a rectangle (`keep`), optionally clipped to the inside of the arc, minus `cut`
 * shapes. Every edge is a painted line or its extension. Mirrors `shotZone` in core; a unit test
 * checks each label point lands in its own section.
 */
const SHAPES: Record<ShotZone, { keep: string; insideArc?: boolean; cut: ('arc' | 'key' | 'restricted')[] }> = {
  restricted: { keep: circle(RESTRICTED_R), cut: [] },
  paint: { keep: rect(KEY.x, KEY.y, KEY.w, KEY.h), cut: ['restricted'] },
  midLeftBaseline: { keep: rect(0, CORNER_Y, LANE_L, H - CORNER_Y), insideArc: true, cut: [] },
  midRightBaseline: { keep: rect(LANE_R, CORNER_Y, W - LANE_R, H - CORNER_Y), insideArc: true, cut: [] },
  midLeftWing: { keep: rect(0, 0, LANE_L, CORNER_Y), insideArc: true, cut: [] },
  midRightWing: { keep: rect(LANE_R, 0, W - LANE_R, CORNER_Y), insideArc: true, cut: [] },
  midTop: { keep: rect(LANE_L, 0, KEY.w, FT), insideArc: true, cut: [] },
  corner3Left: { keep: rect(0, CORNER_Y, 75, H - CORNER_Y), cut: ['arc'] },
  corner3Right: { keep: rect(75, CORNER_Y, 75, H - CORNER_Y), cut: ['arc'] },
  wing3Left: { keep: rect(0, 0, LANE_L, CORNER_Y), cut: ['arc'] },
  wing3Right: { keep: rect(LANE_R, 0, W - LANE_R, CORNER_Y), cut: ['arc'] },
  top3: { keep: rect(LANE_L, 0, KEY.w, CORNER_Y), cut: ['arc'] },
};
const CUTS = { arc: INSIDE_ARC, key: rect(KEY.x, KEY.y, KEY.w, KEY.h), restricted: circle(RESTRICTED_R) };

/** FIBA half court with the 12 shot sections. Baseline at the bottom. */
export function Court({ onTap, highlight, fills = {}, labels = {}, children, class: cls, testId, id = 'court' }: CourtProps) {
  const down = (e: JSX.TargetedPointerEvent<SVGSVGElement>) => {
    if (!onTap) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const p = toCourt(((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H);
    onTap(Math.min(1, Math.max(0, p.x)), Math.min(1, Math.max(0, p.y)));
  };
  return (
    <svg class={`court ${cls ?? ''}`} viewBox={`0 0 ${W} ${H}`} onPointerDown={down} data-testid={testId} role={onTap ? 'button' : 'img'} aria-label="Half court">
      <defs>
        <clipPath id={`${id}-in`}>
          <path d={INSIDE_ARC} />
        </clipPath>
        <mask id={`${id}-out`} maskUnits="userSpaceOnUse" x="0" y="0" width={W} height={H}>
          <rect width={W} height={H} fill="white" />
          <path d={INSIDE_ARC} fill="black" />
        </mask>
        {ZONES.map(({ id: z }) => (
          <mask key={z} id={`${id}-${z}`} maskUnits="userSpaceOnUse" x="0" y="0" width={W} height={H}>
            <rect width={W} height={H} fill="black" />
            <path d={SHAPES[z].keep} fill="white" clip-path={SHAPES[z].insideArc ? `url(#${id}-in)` : undefined} />
            {SHAPES[z].cut.map((c) => <path key={c} d={CUTS[c]} fill="black" />)}
          </mask>
        ))}
      </defs>
      <rect class="court-floor" width={W} height={H} />
      {ZONES.map(({ id: z }) => (
        <rect key={z} class={`court-zone${highlight === z ? ' is-hit' : ''}`} data-zone={z} mask={`url(#${id}-${z})`} width={W} height={H} style={fills[z] ? { fill: fills[z] } : undefined} />
      ))}
      {/* Dashed where the floor has no paint: the lane lines extended, and the corner-line height (corner/wing split, 2s and 3s). */}
      <g class="court-divider">
        <path clip-path={`url(#${id}-in)`} d={`M${LANE_L} 0 V${FT} M${LANE_R} 0 V${FT}`} />
        <path mask={`url(#${id}-out)`} d={`M${LANE_L} 0 V${CORNER_Y} M${LANE_R} 0 V${CORNER_Y}`} />
        <path d={`M0 ${CORNER_Y} H${LANE_L} M${LANE_R} ${CORNER_Y} H${W}`} />
      </g>
      {/* Painted lines (all of them section boundaries). */}
      <g class="court-line">
        <rect x="0.5" y="0.5" width={W - 1} height={H - 1} />
        <path d={`M9 ${H} V${CORNER_Y} A${ARC_R} ${ARC_R} 0 0 1 141 ${CORNER_Y} V${H}`} />
        <rect x={KEY.x} y={KEY.y} width={KEY.w} height={KEY.h} />
        <path d={`M${BASKET.x - RESTRICTED_R} ${BASKET.y} A${RESTRICTED_R} ${RESTRICTED_R} 0 0 1 ${BASKET.x + RESTRICTED_R} ${BASKET.y}`} />
      </g>
      {/* Floor paint that isn't a section boundary: FT circle top, half-court circle. */}
      <g class="court-paint">
        <path d={`M${KEY.x + 7} ${KEY.y} A18 18 0 0 1 ${KEY.x + KEY.w - 7} ${KEY.y}`} />
        <path d="M60 0 A18 18 0 0 0 90 0" />
      </g>
      <line class="court-board" x1="66" y1="128" x2="84" y2="128" />
      <circle class="court-rim" cx={BASKET.x} cy={BASKET.y} r="2.3" />
      {ZONES.map(({ id: z }) =>
        labels[z] ? (
          <text key={z} class="court-label" x={ZONE_LABEL_AT[z][0]} y={ZONE_LABEL_AT[z][1]} text-anchor="middle" dominant-baseline="middle">
            {labels[z]}
          </text>
        ) : null,
      )}
      {children}
    </svg>
  );
}
