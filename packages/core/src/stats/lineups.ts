import type { GameEvent, Team } from '../events';
import { walk } from './walk';

const MINUTE = 60_000;

export interface Split {
  /** Milliseconds. */
  min: number;
  ptsFor: number;
  ptsAgainst: number;
  plusMinus: number;
  /** +/- per 40 minutes; null with no minutes. */
  per40: number | null;
}

export interface Lineup extends Split {
  /** Player ids, sorted. */
  players: string[];
}

export interface OnOff {
  playerId: string;
  team: Team;
  on: Split;
  off: Split;
}

const split = (min: number, ptsFor: number, ptsAgainst: number): Split => ({
  min,
  ptsFor,
  ptsAgainst,
  plusMinus: ptsFor - ptsAgainst,
  per40: min ? ((ptsFor - ptsAgainst) / (min / MINUTE)) * 40 : null,
});

const other = (t: Team): Team => (t === 'A' ? 'B' : 'A');

/** Every five-man unit per team, most minutes first. */
export function lineups(events: readonly GameEvent[]): Record<Team, Lineup[]> {
  const acc: Record<Team, Map<string, { min: number; ptsFor: number; ptsAgainst: number }>> = { A: new Map(), B: new Map() };
  for (const { before, after, elapsed } of walk(events)) {
    for (const t of ['A', 'B'] as const) {
      const key = [...before.onFloor[t]].sort().join(',');
      const u = acc[t].get(key) ?? { min: 0, ptsFor: 0, ptsAgainst: 0 };
      u.min += elapsed;
      u.ptsFor += after.score[t] - before.score[t];
      u.ptsAgainst += after.score[other(t)] - before.score[other(t)];
      if (u.min || u.ptsFor || u.ptsAgainst) acc[t].set(key, u);
    }
  }
  const list = (t: Team) =>
    [...acc[t]]
      .map(([key, u]) => ({ players: key ? key.split(',') : [], ...split(u.min, u.ptsFor, u.ptsAgainst) }))
      .sort((x, y) => y.min - x.min || x.players.join().localeCompare(y.players.join()));
  return { A: list('A'), B: list('B') };
}

/** Team results with each player on the floor vs off it. */
export function onOff(events: readonly GameEvent[]): OnOff[] {
  const on = new Map<string, { team: Team; min: number; ptsFor: number; ptsAgainst: number }>();
  let total = 0;
  const score = { A: 0, B: 0 };
  for (const { event, before, after, elapsed } of walk(events)) {
    if (event.type === 'gameStart') {
      for (const t of ['A', 'B'] as const) for (const { playerId } of event.payload.roster[t]) on.set(playerId, { team: t, min: 0, ptsFor: 0, ptsAgainst: 0 });
    }
    total += elapsed;
    for (const t of ['A', 'B'] as const) {
      for (const id of before.onFloor[t]) {
        const p = on.get(id);
        if (!p) continue;
        p.min += elapsed;
        p.ptsFor += after.score[t] - before.score[t];
        p.ptsAgainst += after.score[other(t)] - before.score[other(t)];
      }
    }
    score.A = after.score.A;
    score.B = after.score.B;
  }
  return [...on].map(([playerId, p]) => ({
    playerId,
    team: p.team,
    on: split(p.min, p.ptsFor, p.ptsAgainst),
    off: split(total - p.min, score[p.team] - p.ptsFor, score[other(p.team)] - p.ptsAgainst),
  }));
}
