import type { FoulKind, Team } from '@stats/core';
import type { Entry, Input } from './entry';

export type KeyCommand =
  | { input: Input }
  | { digit: string }
  | { do: 'clock' | 'undo' | 'help' | 'commit' | 'commitOrConfirm' | 'switchTeam' }
  | null;

const FOUL_KEYS: Record<string, FoulKind> = { p: 'personal', s: 'shooting', o: 'offensive', t: 'technical', u: 'unsportsmanlike', d: 'disqualifying' };
const TURNOVER_KEYS = {
  b: 'badPass', l: 'ballHandling', t: 'travelling', d: 'doubleDribble', o: 'outOfBounds', c: 'shotClock', k: 'backcourt', f: 'offensiveFoul',
} as const;
const ACTION_KEYS: Record<string, Input> = {
  s: { kind: 'shot', value: 2, made: true },
  x: { kind: 'shot', value: 2, made: false },
  d: { kind: 'shot', value: 3, made: true },
  c: { kind: 'shot', value: 3, made: false },
  r: { kind: 'rebound' },
  v: { kind: 'assist' },
  l: { kind: 'steal' },
  b: { kind: 'block' },
  t: { kind: 'turnover' },
  f: { kind: 'foul' },
  u: { kind: 'sub' },
};

/** Map a key press to what it means in the current entry step. */
export function keyCommand(e: { key: string; shiftKey: boolean }, entry: Entry): KeyCommand {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === ' ') return { do: 'clock' };
  if (key === 'Escape') return { input: { kind: 'skip' } };
  if (key === '?') return { do: 'help' };

  switch (entry.step) {
    case 'foulKind':
      return FOUL_KEYS[key] ? { input: { kind: 'foulKind', value: FOUL_KEYS[key] } } : null;
    case 'turnoverKind':
      return key in TURNOVER_KEYS ? { input: { kind: 'turnoverKind', value: TURNOVER_KEYS[key as keyof typeof TURNOVER_KEYS] } } : null;
    case 'ftCount':
      return key === '1' || key === '2' || key === '3' ? { input: { kind: 'ftCount', n: Number(key) as 1 | 2 | 3 } } : null;
    case 'shotResult':
      if (key === 'm' || key === 'n') return { input: { kind: 'result', made: key === 'm' } };
      if (key === 'Tab') return { input: { kind: 'flipValue' } };
      break;
    case 'rebound':
      if (e.shiftKey && (key === 'a' || key === 'b')) return { input: { kind: 'team', team: key.toUpperCase() as Team } };
      break;
  }

  if (key === 'Tab') return { do: 'switchTeam' };
  if (/^[0-9]$/.test(key)) return { digit: key };
  if (key === 'Enter') return { do: entry.step === 'sub' ? 'commitOrConfirm' : 'commit' };
  if (key === 'z') return { do: 'undo' };
  if (key === 'm' || key === 'n') return { input: { kind: 'ft', made: key === 'm' } };
  if (entry.step === 'player' && ACTION_KEYS[key]) return { input: ACTION_KEYS[key] };
  return null;
}

/**
 * Jersey number -> player id. Only players on the floor count (the whole roster during a sub).
 * When both teams have the number, the preferred team wins; Tab flips the preference.
 */
export function resolveJersey(
  jersey: string,
  prefer: Team,
  players: readonly { id: string; jersey: string; team: Team }[],
  onFloor: Record<Team, readonly string[]>,
  includeBench: boolean,
): string | undefined {
  const matches = players.filter((p) => p.jersey === jersey && (includeBench || onFloor[p.team].includes(p.id)));
  return (matches.find((p) => p.team === prefer) ?? matches[0])?.id;
}

/** The team a jersey most likely belongs to in the current prompt. */
export function promptTeam(entry: Entry, teamOf: (id: string) => Team | undefined, fallback: Team): Team {
  const other = (t: Team): Team => (t === 'A' ? 'B' : 'A');
  switch (entry.step) {
    case 'assist':
      return teamOf(entry.shot.payload.shooter) ?? fallback;
    case 'fouled':
      return other(entry.foul.team);
    case 'steal':
      return other(entry.turnover.payload.team);
    case 'sub':
      return entry.team;
    default:
      return fallback;
  }
}
