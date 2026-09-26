import * as v from 'valibot';
import { FOUL_KINDS, RuleSetSchema } from './rules';

export const TEAMS = ['A', 'B'] as const;
export type Team = (typeof TEAMS)[number];
export const ROLES = ['single', 'teamA', 'teamB', 'clock', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export const TURNOVER_KINDS = [
  'badPass',
  'ballHandling',
  'travelling',
  'doubleDribble',
  'outOfBounds',
  'offensiveFoul',
  'threeSeconds',
  'fiveSeconds',
  'eightSeconds',
  'shotClock',
  'backcourt',
  'other',
] as const;

const id = v.pipe(v.string(), v.minLength(1));
const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const positive = v.pipe(v.number(), v.integer(), v.minValue(1));
const unit = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const team = v.picklist(TEAMS);
const empty = v.object({});

export const EnvelopeSchema = v.object({
  id,
  gameId: id,
  /** Server-assigned canonical sequence. null until acknowledged. */
  seq: v.nullable(positive),
  deviceId: id,
  deviceSeq: count,
  role: v.picklist(ROLES),
  /** 0 = pregame. Overtime periods continue after regulation (5, 6, ...). */
  period: count,
  /** Milliseconds remaining in the period. */
  gameClock: count,
  wallClock: count,
});
export type Envelope = v.InferOutput<typeof EnvelopeSchema>;

const body = <T extends string, P extends v.GenericSchema>(type: T, payload: P) =>
  v.object({ type: v.literal(type), payload });

const RosterSchema = v.array(v.object({ playerId: id, jersey: v.string() }));

/** Events that describe the game itself. These are the only ones that can be amended. */
const PlayBodySchema = v.variant('type', [
  body('gameStart', v.object({ rules: RuleSetSchema, roster: v.object({ A: RosterSchema, B: RosterSchema }), shotLocations: v.boolean() })),
  body('periodStart', v.object({ lineups: v.object({ A: v.array(id), B: v.array(id) }) })),
  body('periodEnd', empty),
  body('gameEnd', empty),
  body('clockStart', empty),
  body('clockStop', empty),
  body('timeout', v.object({ team })),
  body('jumpBall', v.object({ wonBy: team })),
  body('possessionArrow', v.object({ team })),
  body(
    'substitution',
    v.pipe(
      v.object({ team, out: v.array(id), in: v.array(id) }),
      v.check((p) => p.out.length + p.in.length > 0, 'substitution moves no players'),
    ),
  ),
  body(
    'shot',
    v.pipe(
      v.object({
        shooter: id,
        value: v.picklist([2, 3]),
        made: v.boolean(),
        x: v.optional(unit),
        y: v.optional(unit),
        assist: v.optional(id),
        block: v.optional(id),
      }),
      v.check((p) => (p.x === undefined) === (p.y === undefined), 'x and y must be given together'),
      v.check((p) => p.made || p.assist === undefined, 'assist on a missed shot'),
      v.check((p) => !p.made || p.block === undefined, 'block on a made shot'),
    ),
  ),
  body(
    'freeThrow',
    v.pipe(
      v.object({ shooter: id, made: v.boolean(), attempt: positive, of: v.pipe(positive, v.maxValue(3)) }),
      v.check((p) => p.attempt <= p.of, 'attempt is greater than total'),
    ),
  ),
  body('rebound', v.object({ team, player: v.optional(id), kind: v.picklist(['offensive', 'defensive']) })),
  body('turnover', v.object({ team, player: v.optional(id), kind: v.picklist(TURNOVER_KINDS), steal: v.optional(id) })),
  body(
    'foul',
    v.pipe(
      v.object({
        team,
        offender: v.picklist(['player', 'coach', 'bench']),
        player: v.optional(id),
        kind: v.picklist(FOUL_KINDS),
        fouled: v.optional(id),
        freeThrows: v.pipe(count, v.maxValue(3)),
      }),
      v.check((p) => (p.offender === 'player') === (p.player !== undefined), 'player fouls need a player, others must not have one'),
      v.check(
        (p) => p.offender === 'player' || ['technical', 'unsportsmanlike', 'disqualifying'].includes(p.kind),
        'coach and bench fouls must be technical, unsportsmanlike or disqualifying',
      ),
    ),
  ),
]);
export type PlayBody = v.InferOutput<typeof PlayBodySchema>;

const CorrectionBodySchema = v.variant('type', [
  body('amend', v.object({ targetId: id, body: PlayBodySchema })),
  body('void', v.object({ targetId: id })),
]);

const role = v.picklist(ROLES);
const SessionBodySchema = v.variant('type', [
  body('roleClaim', v.object({ role })),
  body('roleRelease', v.object({ role })),
  body('roleTransfer', v.object({ role, toDeviceId: id })),
  /** Period-end reconciliation: the score on the official scoreboard. */
  body('checkpoint', v.object({ score: v.object({ A: count, B: count }) })),
  body('adminLock', empty),
]);

export const EventSchema = v.intersect([
  EnvelopeSchema,
  v.variant('type', [PlayBodySchema, CorrectionBodySchema, SessionBodySchema]),
]);
export type GameEvent = v.InferOutput<typeof EventSchema>;
export type EventType = GameEvent['type'];
export type EventOf<T extends EventType> = Extract<GameEvent, { type: T }>;

/** Validate untrusted input at a boundary (network, storage, import). */
export const parseEvent = (input: unknown) => v.safeParse(EventSchema, input);

export const isCorrection = (e: GameEvent): e is EventOf<'amend' | 'void'> => e.type === 'amend' || e.type === 'void';
