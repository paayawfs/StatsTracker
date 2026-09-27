import type { GameEvent, Team } from '../events';
import { walk } from './walk';

/** Counting stats shared by player and team lines (FIBA Statistics Manual). */
export interface Counts {
  pts: number;
  fgm: number;
  fga: number;
  p2m: number;
  p2a: number;
  p3m: number;
  p3a: number;
  ftm: number;
  fta: number;
  oreb: number;
  dreb: number;
  reb: number;
  ast: number;
  to: number;
  stl: number;
  blk: number;
  pf: number;
  /** Fouls drawn. */
  fd: number;
}

export interface PlayerLine extends Counts {
  playerId: string;
  team: Team;
  /** Milliseconds on the floor. */
  min: number;
  plusMinus: number;
  /** FIBA efficiency: PTS + REB + AST + STL + BLK - missed FG - missed FT - TO. */
  eff: number;
}

export interface TeamLine extends Counts {
  /** Rebounds credited to the team, not a player (included in `reb`). */
  teamReb: number;
  /** Turnovers credited to the team, not a player (included in `to`). */
  teamTo: number;
  /** Coach and bench fouls (not in `pf`). */
  benchFouls: number;
}

export interface BoxScore {
  players: PlayerLine[];
  teams: Record<Team, TeamLine>;
}

const zero = (): Counts => ({ pts: 0, fgm: 0, fga: 0, p2m: 0, p2a: 0, p3m: 0, p3a: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, reb: 0, ast: 0, to: 0, stl: 0, blk: 0, pf: 0, fd: 0 });

export const efficiency = (c: Counts) => c.pts + c.reb + c.ast + c.stl + c.blk - (c.fga - c.fgm) - (c.fta - c.ftm) - c.to;

/** Box score from the effective event log. Works mid-game: minutes run up to the latest event. */
export function boxScore(events: readonly GameEvent[]): BoxScore {
  const players = new Map<string, PlayerLine>();
  const teams: Record<Team, TeamLine> = {
    A: { ...zero(), teamReb: 0, teamTo: 0, benchFouls: 0 },
    B: { ...zero(), teamReb: 0, teamTo: 0, benchFouls: 0 },
  };
  const line = (id: string | undefined) => (id ? players.get(id) : undefined);
  /** Add to a player's line and their team's line. */
  const add = (id: string | undefined, k: keyof Counts, n = 1) => {
    const p = line(id);
    if (!p) return;
    p[k] += n;
    teams[p.team][k] += n;
  };

  for (const { event: e, before, after, elapsed } of walk(events)) {
    if (e.type === 'gameStart') {
      for (const t of ['A', 'B'] as const)
        for (const { playerId } of e.payload.roster[t]) players.set(playerId, { playerId, team: t, ...zero(), min: 0, plusMinus: 0, eff: 0 });
    }
    for (const t of ['A', 'B'] as const) for (const id of before.onFloor[t]) {
      const p = line(id);
      if (p) p.min += elapsed;
    }
    // Plus-minus: points scored on this event, credited to whoever was on the floor for it.
    for (const t of ['A', 'B'] as const) {
      const scored = after.score[t] - before.score[t];
      if (!scored) continue;
      const other = t === 'A' ? 'B' : 'A';
      for (const id of before.onFloor[t]) { const p = line(id); if (p) p.plusMinus += scored; }
      for (const id of before.onFloor[other]) { const p = line(id); if (p) p.plusMinus -= scored; }
    }

    switch (e.type) {
      case 'shot': {
        const { shooter, value, made, assist, block } = e.payload;
        const pts = after.score.A - before.score.A + after.score.B - before.score.B;
        add(shooter, 'fga');
        add(shooter, value === 3 ? 'p3a' : 'p2a');
        if (made) {
          add(shooter, 'fgm');
          add(shooter, value === 3 ? 'p3m' : 'p2m');
          add(shooter, 'pts', pts);
          add(assist, 'ast');
        }
        add(block, 'blk');
        break;
      }
      case 'freeThrow':
        add(e.payload.shooter, 'fta');
        if (e.payload.made) {
          add(e.payload.shooter, 'ftm');
          add(e.payload.shooter, 'pts', after.score.A - before.score.A + after.score.B - before.score.B);
        }
        break;
      case 'rebound': {
        const t = e.payload.team;
        if (line(e.payload.player)) {
          add(e.payload.player, e.payload.kind === 'offensive' ? 'oreb' : 'dreb');
          add(e.payload.player, 'reb');
        } else {
          teams[t].teamReb++;
          teams[t].reb++;
        }
        break;
      }
      case 'turnover':
        if (line(e.payload.player)) add(e.payload.player, 'to');
        else {
          teams[e.payload.team].teamTo++;
          teams[e.payload.team].to++;
        }
        add(e.payload.steal, 'stl');
        break;
      case 'foul':
        if (e.payload.offender === 'player') add(e.payload.player, 'pf');
        else teams[e.payload.team].benchFouls++;
        add(e.payload.fouled, 'fd');
        break;
    }
  }

  const lines = [...players.values()];
  for (const p of lines) p.eff = efficiency(p);
  return { players: lines, teams };
}
