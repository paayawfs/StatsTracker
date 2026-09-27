import type { GameEvent, Role, Team } from './events';
import { check } from './validate';
import { periodLength, type RuleSet } from './rules';

export interface Flag {
  eventId: string;
  code: string;
  detail?: string;
}

export interface FreeThrowDue {
  team: Team;
  /** null = technical: any player of `team` may shoot. */
  shooter: string | null;
  next: number;
  of: number;
  /** Technical, unsportsmanlike or disqualifying: no rebound after the last one. */
  deadBall?: true;
}

export interface GameState {
  rules: RuleSet | null;
  shotLocations: boolean;
  phase: 'pregame' | 'live' | 'break' | 'final';
  period: number;
  clock: { running: boolean; gameClock: number; wallClock: number };
  /** playerId -> team */
  roster: Record<string, Team>;
  onFloor: Record<Team, string[]>;
  score: Record<Team, number>;
  personalFouls: Record<string, number>;
  /** team -> period -> count */
  teamFouls: Record<Team, Record<number, number>>;
  timeouts: Record<Team, Record<number, number>>;
  freeThrowQueue: FreeThrowDue[];
  reboundable: boolean;
  arrow: Team | null;
  /** role -> deviceId */
  roles: Partial<Record<Role, string>>;
  clockRoleSeen: boolean;
  locked: boolean;
  flags: Flag[];
}

export const initialState: GameState = {
  rules: null,
  shotLocations: false,
  phase: 'pregame',
  period: 0,
  clock: { running: false, gameClock: 0, wallClock: 0 },
  roster: {},
  onFloor: { A: [], B: [] },
  score: { A: 0, B: 0 },
  personalFouls: {},
  teamFouls: { A: {}, B: {} },
  timeouts: { A: {}, B: {} },
  freeThrowQueue: [],
  reboundable: false,
  arrow: null,
  roles: {},
  clockRoleSeen: false,
  locked: false,
  flags: [],
};

const other = (t: Team): Team => (t === 'A' ? 'B' : 'A');
const bump = (m: Record<string | number, number>, k: string | number) => {
  m[k] = (m[k] ?? 0) + 1;
};

/** Apply one event. Pure: returns a new state and never mutates `state`. */
export function apply(state: GameState, e: GameEvent): GameState {
  // ponytail: whole-state clone per event (~1 KB). Swap for structural sharing if profiling says so.
  const s = structuredClone(state);
  const r = s.rules;
  s.flags.push(...check(state, e));

  switch (e.type) {
    case 'gameStart': {
      const { rules, roster, shotLocations } = e.payload;
      s.rules = rules;
      s.shotLocations = shotLocations;
      s.roster = {};
      for (const t of ['A', 'B'] as const) for (const p of roster[t]) s.roster[p.playerId] = t;
      break;
    }
    case 'periodStart':
      s.period = e.period;
      s.phase = 'live';
      s.onFloor = { A: [...e.payload.lineups.A], B: [...e.payload.lineups.B] };
      s.clock = { running: false, gameClock: r ? periodLength(r, e.period) : e.gameClock, wallClock: e.wallClock };
      s.reboundable = false;
      break;
    case 'periodEnd':
      s.phase = 'break';
      s.clock = { running: false, gameClock: e.gameClock, wallClock: e.wallClock };
      s.freeThrowQueue = [];
      s.reboundable = false;
      break;
    case 'gameEnd':
      s.phase = 'final';
      s.clock.running = false;
      break;
    case 'clockStart':
    case 'clockStop':
      s.clock = { running: e.type === 'clockStart', gameClock: e.gameClock, wallClock: e.wallClock };
      break;
    case 'timeout':
      bump(s.timeouts[e.payload.team], s.period);
      break;
    case 'possessionArrow':
      s.arrow = e.payload.team;
      break;
    case 'jumpBall':
      break;
    case 'substitution': {
      const { team, out, in: incoming } = e.payload;
      s.onFloor[team] = [...s.onFloor[team].filter((p) => !out.includes(p)), ...incoming];
      break;
    }
    case 'shot': {
      const { shooter, value, made } = e.payload;
      const team = s.roster[shooter];
      if (made && team && r) s.score[team] += value === 3 ? r.points.three : r.points.two;
      s.reboundable = !made;
      break;
    }
    case 'freeThrow': {
      const { shooter, made, attempt, of } = e.payload;
      const team = s.roster[shooter];
      if (made && team && r) s.score[team] += r.points.freeThrow;
      const due = s.freeThrowQueue.find((d) => d.team === team && (d.shooter === null || d.shooter === shooter));
      if (due) {
        due.shooter ??= shooter; // whoever takes the first free throw of a set shoots the rest
        due.next = attempt + 1;
        if (due.next > due.of) s.freeThrowQueue.splice(s.freeThrowQueue.indexOf(due), 1);
      }
      s.reboundable = !made && attempt === of && !due?.deadBall;
      break;
    }
    case 'rebound':
    case 'turnover':
      s.reboundable = false;
      break;
    case 'foul': {
      const { team, offender, player, kind, fouled, freeThrows } = e.payload;
      if (offender === 'player' && player) {
        bump(s.personalFouls, player);
        if (r?.teamFoulKinds.includes(kind)) bump(s.teamFouls[team], s.period);
      }
      const deadBall = kind === 'technical' || kind === 'unsportsmanlike' || kind === 'disqualifying';
      if (freeThrows > 0) s.freeThrowQueue.push({ team: other(team), shooter: fouled ?? null, next: 1, of: freeThrows, ...(deadBall ? { deadBall: true as const } : {}) });
      break;
    }
    case 'roleClaim':
      s.roles[e.payload.role] ??= e.deviceId;
      if (e.payload.role === 'clock') s.clockRoleSeen = true;
      break;
    case 'roleRelease':
      delete s.roles[e.payload.role];
      break;
    case 'roleTransfer':
      s.roles[e.payload.role] = e.payload.toDeviceId;
      if (e.payload.role === 'clock') s.clockRoleSeen = true;
      break;
    case 'adminLock':
      s.locked = true;
      break;
    case 'checkpoint':
    case 'amend':
    case 'void':
      break;
  }
  return s;
}

/** Fold an already-ordered, already-resolved log into state. Duplicate ids are ignored. */
export function replay(log: readonly GameEvent[], from: GameState = initialState): GameState {
  const seen = new Set<string>();
  let s = from;
  for (const e of log) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    s = apply(s, e);
  }
  return s;
}
