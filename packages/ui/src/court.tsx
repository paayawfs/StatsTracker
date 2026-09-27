import { ZONES, type ShotZone } from '@stats/core';
import type { ComponentChildren, JSX } from 'preact';
import { ARC_R, BASKET, CORNER_Y, H, INSIDE_ARC, KEY, RESTRICTED_R, RIM_RING, ray, SHORT_RING, toCourt, W, wedge, ZONE_LABEL_AT } from './geometry';

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

const side = (left: boolean) => (left ? `M0 ${BASKET.y} H75 V${H} H0 Z ${wedge(150, 180)}` : `M75 ${BASKET.y} H${W} V${H} H75 Z ${wedge(0, 30)}`);

/**
 * How each section is cut from basic shapes: `keep` (white) optionally clipped to the inside of
 * the arc, then `cut` (black) removed. Mirrors `shotZone` in core; a unit test checks each label
 * point lands in its own section.
 */
const SHAPES: Record<ShotZone, { keep: string; insideArc?: boolean; cut: ('arc' | 'inner' | 'rim' | 'centre')[] }> = {
  rim: { keep: circle(RIM_RING), cut: [] },
  shortMid: { keep: circle(SHORT_RING), cut: ['rim'] },
  midLeftBaseline: { keep: side(true), insideArc: true, cut: ['inner'] },
  midRightBaseline: { keep: side(false), insideArc: true, cut: ['inner'] },
  midLeftWing: { keep: wedge(102, 150), insideArc: true, cut: ['inner'] },
  midRightWing: { keep: wedge(30, 78), insideArc: true, cut: ['inner'] },
  midTop: { keep: wedge(78, 102), insideArc: true, cut: ['inner'] },
  corner3Left: { keep: rect(0, CORNER_Y, 75, H - CORNER_Y), cut: ['arc'] },
  corner3Right: { keep: rect(75, CORNER_Y, 75, H - CORNER_Y), cut: ['arc'] },
  wing3Left: { keep: rect(0, 0, 75, CORNER_Y), cut: ['arc', 'centre'] },
  wing3Right: { keep: rect(75, 0, 75, CORNER_Y), cut: ['arc', 'centre'] },
  top3: { keep: wedge(78, 102), cut: ['arc'] },
};

function rect(x: number, y: number, w: number, h: number) {
  return `M${x} ${y} h${w} v${h} h${-w} Z`;
}
function circle(r: number) {
  const { x, y } = BASKET;
  return `M${x - r} ${y} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
}
const CUTS = { arc: INSIDE_ARC, inner: circle(SHORT_RING), rim: circle(RIM_RING), centre: wedge(78, 102) };

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
      {/* Section dividers: the two rings, angle cuts beyond the inner ring, corner/wing split outside the arc. */}
      <g class="court-divider">
        <path d={circle(RIM_RING)} />
        <path d={circle(SHORT_RING)} />
      </g>
      <g class="court-divider" clip-path={`url(#${id}-in)`}>
        {[30, 78, 102, 150].map((a) => (
          <path key={a} d={`M${BASKET.x} ${BASKET.y} L${ray(a)}`} mask={`url(#${id}-outer)`} />
        ))}
      </g>
      <mask id={`${id}-outer`} maskUnits="userSpaceOnUse" x="0" y="0" width={W} height={H}>
        <rect width={W} height={H} fill="white" />
        <path d={CUTS.inner} fill="black" />
      </mask>
      <mask id={`${id}-outarc`} maskUnits="userSpaceOnUse" x="0" y="0" width={W} height={H}>
        <rect width={W} height={H} fill="white" />
        <path d={INSIDE_ARC} fill="black" />
      </mask>
      <g class="court-divider" mask={`url(#${id}-outarc)`}>
        <path d={`M0 ${CORNER_Y} H9 M141 ${CORNER_Y} H${W}`} />
        {[78, 102].map((a) => <path key={a} d={`M${BASKET.x} ${BASKET.y} L${ray(a)}`} />)}
      </g>
      {/* Court markings. */}
      <g class="court-line">
        <rect x="0.5" y="0.5" width={W - 1} height={H - 1} />
        <path d={`M9 ${H} V${CORNER_Y} A${ARC_R} ${ARC_R} 0 0 1 141 ${CORNER_Y} V${H}`} />
      </g>
      {/* Floor paint that isn't a section boundary (key, FT circle, no-charge arc): drawn faintly. */}
      <g class="court-paint">
        <rect x={KEY.x} y={KEY.y} width={KEY.w} height={KEY.h} />
        <path d={`M${KEY.x + 7} ${KEY.y} A18 18 0 0 1 ${KEY.x + KEY.w - 7} ${KEY.y}`} />
        <path d={`M${BASKET.x - RESTRICTED_R} ${BASKET.y} A${RESTRICTED_R} ${RESTRICTED_R} 0 0 1 ${BASKET.x + RESTRICTED_R} ${BASKET.y}`} />
        <path d={`M60 0 A18 18 0 0 0 90 0`} />
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

