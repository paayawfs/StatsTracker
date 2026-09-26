import type { GameEvent, Team } from './events';
import type { Flag, GameState } from './reducer';
import { timeoutsAllowed } from './rules';

const other = (t: Team): Team => (t === 'A' ? 'B' : 'A');
const ALLOWED_BEFORE_START = new Set(['roleClaim', 'roleRelease', 'roleTransfer', 'adminLock', 'amend', 'void', 'gameStart']);

/** Team fouls that count toward the bonus in the current period. */
export function teamFoulCount(s: GameState, team: Team): number {
  const r = s.rules;
  const fouls = s.teamFouls[team];
  if (!r || s.period <= r.periods || !r.teamFoulBonus.overtimeCarriesLastPeriod) return fouls[s.period] ?? 0;
  let total = fouls[r.periods] ?? 0;
  for (let p = r.periods + 1; p <= s.period; p++) total += fouls[p] ?? 0;
  return total;
}

/**
 * Game-rule checks for `e` against the state before it. Never rejects: problems become flags so
 * no real event is lost when offline devices merge.
 */
export function check(s: GameState, e: GameEvent): Flag[] {
  const flags: Flag[] = [];
  const flag = (code: string, detail?: string) => flags.push(detail === undefined ? { eventId: e.id, code } : { eventId: e.id, code, detail });

  if (e.type === 'roleClaim') {
    const holder = s.roles[e.payload.role];
    if (holder && holder !== e.deviceId) flag('role-held', `${e.payload.role} held by ${holder}`);
    return flags;
  }
  if ((e.type === 'amend' || e.type === 'void') && s.locked && e.role !== 'admin') flag('locked-correction');

  const r = s.rules;
  if (!r) {
    if (!ALLOWED_BEFORE_START.has(e.type)) flag('no-game-start');
    return flags;
  }
  const fouledOut = (id: string) => (s.personalFouls[id] ?? 0) >= r.personalFoulLimit;

  /** Check a player involved in the event. Returns their team, or undefined if unknown. */
  const player = (id: string, team?: Team): Team | undefined => {
    const t = s.roster[id];
    if (!t) return flag('unknown-player', id), undefined;
    if (team && t !== team) flag('wrong-team', id);
    if (!s.onFloor[t].includes(id)) flag('not-on-floor', id);
    if (fouledOut(id)) flag('fouled-out', id);
    return t;
  };
  const lineupSize = (onFloor: Record<Team, string[]>) => {
    for (const t of ['A', 'B'] as const) if (onFloor[t].length !== 5) flag('lineup-size', `${t} has ${onFloor[t].length} on floor`);
  };

  switch (e.type) {
    case 'periodStart': {
      const { lineups } = e.payload;
      for (const t of ['A', 'B'] as const)
        for (const id of lineups[t]) {
          if (s.roster[id] !== t) flag(s.roster[id] ? 'wrong-team' : 'unknown-player', id);
          else if (fouledOut(id)) flag('fouled-out', id);
        }
      lineupSize(lineups);
      break;
    }
    case 'periodEnd':
      if (s.freeThrowQueue.length) flag('free-throws-unfinished');
      break;
    case 'timeout': {
      const w = timeoutsAllowed(r, s.period);
      const used = w.periods.reduce((n, p) => n + (s.timeouts[e.payload.team][p] ?? 0), 0);
      if (used >= w.count) flag('timeouts-exceeded', `${e.payload.team} ${used + 1}/${w.count}`);
      break;
    }
    case 'substitution': {
      const { team, out, in: incoming } = e.payload;
      for (const id of out) if (s.roster[id] !== team || !s.onFloor[team].includes(id)) flag('bad-substitution', `${id} not on floor`);
      for (const id of incoming) {
        if (s.roster[id] !== team) flag('bad-substitution', `${id} not on team ${team}`);
        else if (s.onFloor[team].includes(id)) flag('bad-substitution', `${id} already on floor`);
        else if (fouledOut(id)) flag('fouled-out', id);
      }
      lineupSize({ ...s.onFloor, [team]: [...s.onFloor[team].filter((id) => !out.includes(id)), ...incoming] });
      break;
    }
    case 'shot': {
      const { shooter, assist, block, x } = e.payload;
      const t = player(shooter);
      if (t && assist) player(assist, t);
      if (t && block) player(block, other(t));
      if (s.shotLocations && x === undefined) flag('missing-location');
      break;
    }
    case 'freeThrow': {
      const { shooter, attempt, of } = e.payload;
      const t = player(shooter);
      const due = s.freeThrowQueue.find((d) => d.team === t && (d.shooter === null || d.shooter === shooter));
      if (!due) flag('unexpected-free-throw');
      else if (due.next !== attempt || due.of !== of) flag('free-throw-order', `expected ${due.next} of ${due.of}`);
      break;
    }
    case 'rebound':
      if (!s.reboundable) flag('rebound-without-miss');
      if (e.payload.player) player(e.payload.player, e.payload.team);
      break;
    case 'turnover':
      if (e.payload.player) player(e.payload.player, e.payload.team);
      if (e.payload.steal) player(e.payload.steal, other(e.payload.team));
      break;
    case 'foul': {
      const { team, player: by, fouled, kind, freeThrows } = e.payload;
      if (by) player(by, team);
      if (fouled) player(fouled, other(team));
      const threshold = s.period > r.periods ? r.teamFoulBonus.overtimeThreshold : r.teamFoulBonus.threshold;
      const ok =
        kind === 'personal' ? freeThrows === (teamFoulCount(s, team) >= threshold ? r.teamFoulBonus.freeThrows : 0)
        : kind === 'offensive' ? freeThrows === 0
        : kind === 'technical' ? freeThrows === r.technicalFreeThrows
        : freeThrows >= 1; // shooting, unsportsmanlike, disqualifying
      if (!ok) flag('free-throw-count', `${kind} foul with ${freeThrows} free throws`);
      break;
    }
    case 'checkpoint': {
      const { A, B } = e.payload.score;
      if (A !== s.score.A || B !== s.score.B) flag('score-mismatch', `scoreboard ${A}-${B}, log ${s.score.A}-${s.score.B}`);
      break;
    }
  }
  return flags;
}

export function dataQuality(s: GameState) {
  const count = (code: string) => s.flags.filter((f) => f.code === code).length;
  return {
    clockRole: s.clockRoleSeen,
    missingLocations: count('missing-location'),
    scoreMismatches: count('score-mismatch'),
    flags: s.flags.length,
  };
}
