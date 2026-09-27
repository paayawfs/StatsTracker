import type { GameEvent } from '@stats/core';
import type { Player } from './session';

/** One line of play-by-play text. */
export function describe(e: GameEvent, players: Map<string, Player>): string {
  const who = (id?: string) => {
    const p = id ? players.get(id) : undefined;
    return p ? `#${p.jersey} ${p.name}` : 'team';
  };
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
      return `${who(e.payload.player)} turnover (${e.payload.kind})${e.payload.steal ? `, steal ${who(e.payload.steal)}` : ''}`;
    case 'foul': {
      const p = e.payload;
      const by = p.offender === 'player' ? who(p.player) : `${p.offender} ${p.team}`;
      return `${by} ${p.kind} foul${p.fouled ? ` on ${who(p.fouled)}` : ''}${p.freeThrows ? `, ${p.freeThrows} FT` : ''}`;
    }
    case 'substitution':
      return `Sub ${e.payload.team}: out ${e.payload.out.map(who).join(', ') || '-'}; in ${e.payload.in.map(who).join(', ') || '-'}`;
    case 'timeout':
      return `Timeout ${e.payload.team}`;
    case 'periodStart':
      return `Start of period ${e.period}`;
    case 'periodEnd':
      return `End of period ${e.period}`;
    case 'checkpoint':
      return `Score check ${e.payload.score.A}-${e.payload.score.B}`;
    case 'amend':
      return 'Correction';
    case 'void':
      return 'Removed an event';
    default:
      return e.type.replace(/([A-Z])/g, ' $1').toLowerCase();
  }
}
