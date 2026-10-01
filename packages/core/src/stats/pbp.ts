import type { GameEvent, Team } from '../events';
import { walk } from './walk';

/** Name for a player id; undefined = a team-level action. */
export type Who = (id?: string) => string;

const words = (camel: string) => camel.replace(/([A-Z])/g, ' $1').toLowerCase();

/** One line of play-by-play text. `teams` names the sides (default "A" / "B"). */
export function describe(e: GameEvent, who: Who, teams: Record<Team, string> = { A: 'A', B: 'B' }): string {
  switch (e.type) {
    case 'shot': {
      const p = e.payload;
      let s = `${who(p.shooter)} ${p.value}PT ${p.made ? 'made' : 'missed'}`;
      if (p.assist) s += `, assist ${who(p.assist)}`;
      if (p.block) s += `, blocked by ${who(p.block)}`;
      return s;
    }
    case 'freeThrow':
      return `${who(e.payload.shooter)} FT ${e.payload.attempt}/${e.payload.of} ${e.payload.made ? 'made' : 'missed'}`;
    case 'rebound':
      return `${who(e.payload.player)} ${e.payload.kind} rebound`;
    case 'turnover':
      return `${who(e.payload.player)} turnover (${words(e.payload.kind)})${e.payload.steal ? `, steal ${who(e.payload.steal)}` : ''}`;
    case 'foul': {
      const p = e.payload;
      const by = p.offender === 'player' ? who(p.player) : `${teams[p.team]} ${p.offender}`;
      return `${by} ${p.kind} foul${p.fouled ? ` on ${who(p.fouled)}` : ''}${p.freeThrows ? `, ${p.freeThrows} FT` : ''}`;
    }
    case 'substitution':
      return `Sub ${teams[e.payload.team]}: out ${e.payload.out.map((id) => who(id)).join(', ') || '-'}; in ${e.payload.in.map((id) => who(id)).join(', ') || '-'}`;
    case 'timeout':
      return `Timeout ${teams[e.payload.team]}`;
    case 'jumpBall':
      return `Jump ball won by ${teams[e.payload.wonBy]}`;
    case 'periodStart':
      return `Start of period ${e.period}`;
    case 'periodEnd':
      return `End of period ${e.period}`;
    case 'gameEnd':
      return 'End of game';
    case 'checkpoint':
      return `Score check ${e.payload.score.A}-${e.payload.score.B}`;
    case 'amend':
      return 'Correction';
    case 'void':
      return 'Removed an event';
    default:
      return words(e.type);
  }
}

export interface PlayRow {
  event: GameEvent;
  text: string;
  /** Score after this play. */
  score: Record<Team, number>;
  /** The team whose score changed, if any. */
  scored?: Team;
}

/** Not interesting to viewers: bookkeeping, and corrections (already applied to the log). */
const HIDDEN = new Set(['gameStart', 'roleClaim', 'roleRelease', 'roleTransfer', 'amend', 'void', 'adminLock', 'checkpoint', 'starters', 'clockStart', 'clockStop', 'possessionArrow']);

/** Viewer play-by-play over the effective log, oldest first, with the running score. */
export function playByPlay(events: readonly GameEvent[], who: Who, teams?: Record<Team, string>): PlayRow[] {
  const rows: PlayRow[] = [];
  for (const { event, before, after } of walk(events)) {
    if (HIDDEN.has(event.type)) continue;
    const scored = after.score.A !== before.score.A ? 'A' : after.score.B !== before.score.B ? 'B' : undefined;
    rows.push({ event, text: describe(event, who, teams), score: { ...after.score }, ...(scored ? { scored } : {}) });
  }
  return rows;
}
