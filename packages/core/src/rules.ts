import * as v from 'valibot';

export const FOUL_KINDS = [
  'personal',
  'shooting',
  'offensive',
  'technical',
  'unsportsmanlike',
  'disqualifying',
] as const;
export type FoulKind = (typeof FOUL_KINDS)[number];

const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const positive = v.pipe(v.number(), v.integer(), v.minValue(1));

const TimeoutWindowSchema = v.object({
  periods: v.pipe(v.array(positive), v.minLength(1)),
  count,
});

export const RuleSetSchema = v.pipe(
  v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    periods: positive,
    periodLengthMs: positive,
    overtimeLengthMs: positive,
    personalFoulLimit: positive,
    teamFoulBonus: v.object({
      /** Bonus free throws start once a team has this many fouls in the period. */
      threshold: count,
      overtimeThreshold: count,
      /** FIBA: overtime fouls continue the last regulation period's count. */
      overtimeCarriesLastPeriod: v.boolean(),
      freeThrows: positive,
    }),
    /** Which player foul kinds count toward the team foul total. */
    teamFoulKinds: v.array(v.picklist(FOUL_KINDS)),
    technicalFreeThrows: count,
    /** Regulation timeout windows, e.g. FIBA: 2 in periods 1-2, 3 in periods 3-4. */
    timeouts: v.array(TimeoutWindowSchema),
    overtimeTimeouts: count,
    points: v.object({ freeThrow: positive, two: positive, three: positive }),
    /** FIBA alternating possession arrow. Off = jump balls every time (NBA). Older rule sets: on. */
    possessionArrow: v.optional(v.boolean(), true),
  }),
  v.check(
    (r) => r.timeouts.every((w) => w.periods.every((p) => p <= r.periods)),
    'timeout window refers to a period outside regulation',
  ),
);
export type RuleSet = v.InferOutput<typeof RuleSetSchema>;

/**
 * Timeout windows for a new number of periods, keeping each window's share of the game:
 * FIBA "2 in 1-2, 3 in 3-4" becomes "2 in 1, 3 in 2" for halves.
 */
export function rescaleTimeouts(windows: RuleSet['timeouts'], from: number, to: number): RuleSet['timeouts'] {
  if (to < 1 || from < 1 || to === from) return windows;
  const out: RuleSet['timeouts'] = [];
  for (const w of windows) {
    const periods = [...new Set(w.periods.map((p) => Math.min(to, Math.max(1, Math.ceil((p * to) / from)))))];
    const same = out.find((o) => o.periods.join() === periods.join());
    if (same) same.count += w.count;
    else out.push({ periods, count: w.count });
  }
  return out;
}

// ponytail: FIBA last-2-minutes timeout cap and NBA 4th-quarter timeout limits are not modelled.
export const FIBA: RuleSet = {
  name: 'FIBA',
  periods: 4,
  periodLengthMs: 600_000,
  overtimeLengthMs: 300_000,
  personalFoulLimit: 5,
  teamFoulBonus: { threshold: 4, overtimeThreshold: 4, overtimeCarriesLastPeriod: true, freeThrows: 2 },
  teamFoulKinds: ['personal', 'shooting', 'offensive', 'technical', 'unsportsmanlike', 'disqualifying'],
  technicalFreeThrows: 1,
  timeouts: [
    { periods: [1, 2], count: 2 },
    { periods: [3, 4], count: 3 },
  ],
  overtimeTimeouts: 1,
  points: { freeThrow: 1, two: 2, three: 3 },
  possessionArrow: true,
};

// ponytail: NBA last-2-minutes bonus rule is not modelled.
export const NBA: RuleSet = {
  name: 'NBA',
  periods: 4,
  periodLengthMs: 720_000,
  overtimeLengthMs: 300_000,
  personalFoulLimit: 6,
  teamFoulBonus: { threshold: 4, overtimeThreshold: 3, overtimeCarriesLastPeriod: false, freeThrows: 2 },
  // NBA: offensive and technical fouls do not count toward the team foul penalty.
  teamFoulKinds: ['personal', 'shooting', 'unsportsmanlike', 'disqualifying'],
  technicalFreeThrows: 1,
  timeouts: [{ periods: [1, 2, 3, 4], count: 7 }],
  overtimeTimeouts: 2,
  points: { freeThrow: 1, two: 2, three: 3 },
  possessionArrow: false,
};

export const periodLength = (r: RuleSet, period: number) =>
  period > r.periods ? r.overtimeLengthMs : r.periodLengthMs;

/** The timeout window a period belongs to. Each overtime period is its own window. */
export function timeoutsAllowed(r: RuleSet, period: number): { periods: number[]; count: number } {
  return r.timeouts.find((w) => w.periods.includes(period)) ?? { periods: [period], count: r.overtimeTimeouts };
}
