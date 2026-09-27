import type { GameEvent, Team } from '../events';
import { replay } from '../reducer';
import { boxScore, efficiency, type Counts } from './box';

export interface SeasonGame {
  gameId: string;
  /** Real team ids for this game's sides (a club can be A in one game and B in the next). */
  teams: Record<Team, string>;
  /** The game's effective event log. */
  events: readonly GameEvent[];
}

type Totals = Counts & { min: number; plusMinus: number; eff: number };

export interface SeasonPlayer extends Totals {
  playerId: string;
  /** Games in which the player got on the floor or recorded a stat. */
  gp: number;
  perGame: Totals;
}

export interface SeasonTeam extends Counts {
  teamId: string;
  gp: number;
  wins: number;
  losses: number;
  ptsAgainst: number;
}

const COUNT_KEYS = ['pts', 'fgm', 'fga', 'p2m', 'p2a', 'p3m', 'p3a', 'ftm', 'fta', 'oreb', 'dreb', 'reb', 'ast', 'to', 'stl', 'blk', 'pf', 'fd'] as const;
const countsOf = (f: (k: (typeof COUNT_KEYS)[number]) => number) => Object.fromEntries(COUNT_KEYS.map((k) => [k, f(k)])) as unknown as Counts;
const zeroTotals = (): Totals => ({ ...countsOf(() => 0), min: 0, plusMinus: 0, eff: 0 });

/** Season totals and per-game averages over each game's box score. */
export function seasonTotals(games: readonly SeasonGame[]): { players: SeasonPlayer[]; teams: SeasonTeam[] } {
  const players = new Map<string, SeasonPlayer>();
  const teams = new Map<string, SeasonTeam>();
  const team = (id: string) => {
    let t = teams.get(id);
    if (!t) teams.set(id, (t = { teamId: id, ...countsOf(() => 0), gp: 0, wins: 0, losses: 0, ptsAgainst: 0 }));
    return t;
  };

  for (const g of games) {
    const final = replay(g.events);
    if (final.phase === 'pregame') continue; // scheduled, not played
    const box = boxScore(g.events);
    for (const line of box.players) {
      let p = players.get(line.playerId);
      if (!p) players.set(line.playerId, (p = { playerId: line.playerId, ...zeroTotals(), gp: 0, perGame: zeroTotals() }));
      const played = line.min > 0 || COUNT_KEYS.some((k) => line[k] !== 0);
      if (played) p.gp++;
      for (const k of COUNT_KEYS) p[k] += line[k];
      p.min += line.min;
      p.plusMinus += line.plusMinus;
    }
    for (const side of ['A', 'B'] as const) {
      const t = team(g.teams[side]);
      const other = side === 'A' ? 'B' : 'A';
      t.gp++;
      for (const k of COUNT_KEYS) t[k] += box.teams[side][k];
      t.ptsAgainst += box.teams[other].pts;
      if (final.phase === 'final' && final.score[side] !== final.score[other]) {
        if (final.score[side] > final.score[other]) t.wins++;
        else t.losses++;
      }
    }
  }

  for (const p of players.values()) {
    p.eff = efficiency(p);
    const per = (n: number) => (p.gp ? n / p.gp : 0);
    p.perGame = { ...countsOf((k) => per(p[k])), min: per(p.min), plusMinus: per(p.plusMinus), eff: per(p.eff) };
  }
  return { players: [...players.values()], teams: [...teams.values()] };
}

const CSV_COLUMNS = ['seq', 'id', 'period', 'gameClock', 'type', 'role', 'deviceId', 'deviceSeq', 'wallClock', 'payload'] as const;
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** Raw event export: envelope columns plus the payload as JSON (RFC 4180 quoting, CRLF). */
export function eventsCsv(events: readonly GameEvent[]): string {
  const rows = events.map((e) => CSV_COLUMNS.map((c) => csvCell(e[c])).join(','));
  return [CSV_COLUMNS.join(','), ...rows].join('\r\n');
}

/** Latency summary: count, median, 95th percentile and max. */
export function summarize(samples: readonly number[]): { n: number; p50: number | null; p95: number | null; max: number | null } {
  if (!samples.length) return { n: 0, p50: null, p95: null, max: null };
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1]! };
}
