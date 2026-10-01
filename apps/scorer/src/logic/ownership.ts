import type { EventBody, GameState, Role, Team } from '@stats/core';

const CONTROL = new Set(['gameStart', 'starters', 'periodStart', 'periodEnd', 'gameEnd', 'clockStart', 'clockStop', 'timeout', 'jumpBall', 'possessionArrow']);

/**
 * Which role owns an event (brief section 6). Mirrors `authorize_event` in
 * supabase/migrations/*_takeover_by_any_scorer.sql; the server has the final word.
 * 'any' = any scorer role may write it (corrections, score checks, unknown shooters).
 */
export function ownerRole(body: EventBody, st: GameState): Role | 'any' {
  if (CONTROL.has(body.type)) return st.roles.clock ? 'clock' : 'teamA';
  switch (body.type) {
    case 'substitution':
    case 'rebound':
    case 'turnover':
    case 'foul':
      return `team${body.payload.team}`;
    case 'shot':
    case 'freeThrow': {
      const t = st.roster[body.payload.shooter];
      return t ? `team${t}` : 'any';
    }
    default:
      return 'any';
  }
}

export function heldRoles(st: GameState, deviceId: string): Role[] {
  return (Object.entries(st.roles) as [Role, string][]).filter(([, d]) => d === deviceId).map(([r]) => r);
}

/** The role to stamp on an event from this device, or null if it may not write it. */
export function roleFor(body: EventBody, st: GameState, deviceId: string): Role | null {
  const held = heldRoles(st, deviceId);
  if (held.includes('single')) return 'single';
  const owner = ownerRole(body, st);
  if (owner === 'any') return held[0] ?? null;
  return held.includes(owner) ? owner : null;
}

export interface Can {
  /** May record primary events for this team. */
  team: (t: Team) => boolean;
  /** May run the clock, periods and timeouts. */
  control: boolean;
}

export function capabilities(st: GameState, deviceId: string): Can {
  const held = heldRoles(st, deviceId);
  const single = held.includes('single');
  return {
    team: (t) => single || held.includes(`team${t}`),
    control: single || held.includes(st.roles.clock ? 'clock' : 'teamA'),
  };
}
