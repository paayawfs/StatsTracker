import fc from 'fast-check';
import type { Envelope, EventOf, EventType, GameEvent, Team } from './events';
import { FIBA, type RuleSet } from './rules';

let n = 0;

/** Build an event with sensible envelope defaults. Each call advances seq, deviceSeq and the clock. */
export function ev<T extends EventType>(
  type: T,
  payload: EventOf<T>['payload'],
  env: Partial<Envelope> = {},
): EventOf<T> {
  n++;
  return {
    id: `e${n}`,
    gameId: 'g1',
    seq: n,
    deviceId: 'd1',
    deviceSeq: n,
    role: 'single',
    period: 1,
    gameClock: 600_000 - n,
    wallClock: n,
    ...env,
    type,
    payload,
  } as EventOf<T>;
}

/** Players a1..a8 and b1..b8. The first five of each start. */
export const players = (t: Team) => Array.from({ length: 8 }, (_, i) => `${t.toLowerCase()}${i + 1}`);

export const gameStart = (rules: RuleSet = FIBA, shotLocations = false) =>
  ev(
    'gameStart',
    {
      rules,
      shotLocations,
      roster: {
        A: players('A').map((playerId, i) => ({ playerId, jersey: String(i + 4) })),
        B: players('B').map((playerId, i) => ({ playerId, jersey: String(i + 4) })),
      },
    },
    { period: 0, gameClock: 0 },
  );

export const periodStart = (period = 1, rules: RuleSet = FIBA) =>
  ev(
    'periodStart',
    { lineups: { A: players('A').slice(0, 5), B: players('B').slice(0, 5) } },
    { period, gameClock: period > rules.periods ? rules.overtimeLengthMs : rules.periodLengthMs },
  );

/** Random but structurally valid game logs, already in canonical order. Not guaranteed rule-valid. */
export const arbGameLog: fc.Arbitrary<GameEvent[]> = fc
  .array(fc.tuple(fc.nat(10), fc.nat(15), fc.boolean()), { maxLength: 60 })
  .map((steps) => {
    const log: GameEvent[] = [gameStart(), periodStart()];
    let period = 1;
    let clock = FIBA.periodLengthMs;
    for (const [kind, k, flag] of steps) {
      clock = Math.max(0, clock - 1000 * (k % 5));
      const env = { period, gameClock: clock };
      const team: Team = flag ? 'A' : 'B';
      const other: Team = flag ? 'B' : 'A';
      const p = players(team)[k % 8]!;
      const q = players(other)[k % 8]!;
      switch (kind) {
        case 0: log.push(ev('shot', { shooter: p, value: k % 2 ? 3 : 2, made: flag }, env)); break;
        case 1: log.push(ev('shot', { shooter: p, value: 2, made: false, ...(k % 3 ? {} : { block: q }) }, env)); break;
        case 2: log.push(ev('freeThrow', { shooter: p, made: flag, attempt: 1, of: 1 + (k % 2) }, env)); break;
        case 3: log.push(ev('rebound', { team, player: p, kind: flag ? 'offensive' : 'defensive' }, env)); break;
        case 4: log.push(ev('turnover', { team, player: p, kind: 'badPass', ...(k % 2 ? { steal: q } : {}) }, env)); break;
        case 5: log.push(ev('foul', { team, offender: 'player', player: p, kind: 'personal', fouled: q, freeThrows: k % 3 }, env)); break;
        case 6: log.push(ev('substitution', { team, out: [p], in: [players(team)[(k + 3) % 8]!] }, env)); break;
        case 7: log.push(ev('timeout', { team }, env)); break;
        case 8: log.push(ev(flag ? 'clockStart' : 'clockStop', {}, env)); break;
        case 9: log.push(ev('possessionArrow', { team }, env)); break;
        case 10:
          log.push(ev('periodEnd', {}, { period, gameClock: 0 }));
          period++;
          log.push(periodStart(period));
          clock = period > FIBA.periods ? FIBA.overtimeLengthMs : FIBA.periodLengthMs;
          break;
      }
    }
    return log;
  });
