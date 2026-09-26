import { describe, expect, test } from 'vitest';
import { parseEvent } from './events';
import { FIBA } from './rules';
import { ev } from './test-helpers';

const roster = {
  A: [{ playerId: 'a1', jersey: '4' }],
  B: [{ playerId: 'b1', jersey: '7' }],
};

// One valid example of every event type.
const valid = [
  ev('gameStart', { rules: FIBA, roster, shotLocations: true }, { period: 0 }),
  ev('periodStart', { lineups: { A: ['a1'], B: ['b1'] } }),
  ev('periodEnd', {}),
  ev('gameEnd', {}),
  ev('clockStart', {}),
  ev('clockStop', {}),
  ev('timeout', { team: 'A' }),
  ev('jumpBall', { wonBy: 'B' }),
  ev('possessionArrow', { team: 'A' }),
  ev('substitution', { team: 'A', out: ['a1'], in: ['a2'] }),
  ev('shot', { shooter: 'a1', value: 3, made: true, x: 0.2, y: 0.8, assist: 'a2' }),
  ev('shot', { shooter: 'a1', value: 2, made: false, block: 'b1' }),
  ev('freeThrow', { shooter: 'a1', made: true, attempt: 1, of: 2 }),
  ev('rebound', { team: 'B', player: 'b1', kind: 'defensive' }),
  ev('rebound', { team: 'A', kind: 'offensive' }),
  ev('turnover', { team: 'A', player: 'a1', kind: 'badPass', steal: 'b1' }),
  ev('foul', { team: 'B', offender: 'player', player: 'b1', kind: 'shooting', fouled: 'a1', freeThrows: 2 }),
  ev('foul', { team: 'B', offender: 'coach', kind: 'technical', freeThrows: 1 }),
  ev('amend', { targetId: 'e5', body: { type: 'shot', payload: { shooter: 'a1', value: 2, made: true } } }),
  ev('void', { targetId: 'e5' }),
  ev('roleClaim', { role: 'teamA' }),
  ev('roleRelease', { role: 'teamA' }),
  ev('roleTransfer', { role: 'teamA', toDeviceId: 'd2' }),
  ev('checkpoint', { score: { A: 10, B: 8 } }),
  ev('adminLock', {}),
];

describe('parseEvent accepts every valid event type', () => {
  test.each(valid.map((e) => [e.type, e] as const))('%s', (_, e) => {
    const r = parseEvent(JSON.parse(JSON.stringify(e)));
    expect(r.success).toBe(true);
    expect(r.output).toEqual(e);
  });
});

describe('parseEvent rejects malformed events', () => {
  const base = ev('shot', { shooter: 'a1', value: 2, made: true });
  const shot = (payload: object) => ({ ...base, payload: { ...base.payload, ...payload } });

  test.each([
    ['unknown type', { ...base, type: 'dunk' }],
    ['missing id', { ...base, id: '' }],
    ['negative game clock', { ...base, gameClock: -1 }],
    ['fractional seq', { ...base, seq: 1.5 }],
    ['unknown role', { ...base, role: 'referee' }],
    ['shot worth 4', shot({ value: 4 })],
    ['assist on a miss', shot({ made: false, assist: 'a2' })],
    ['block on a make', shot({ block: 'b1' })],
    ['x without y', shot({ x: 0.5 })],
    ['location off the court', shot({ x: 1.5, y: 0.5 })],
    ['free throw 3 of 2', { ...base, type: 'freeThrow', payload: { shooter: 'a1', made: true, attempt: 3, of: 2 } }],
    ['player foul without player', { ...base, type: 'foul', payload: { team: 'A', offender: 'player', kind: 'personal', freeThrows: 0 } }],
    ['coach personal foul', { ...base, type: 'foul', payload: { team: 'A', offender: 'coach', kind: 'personal', freeThrows: 0 } }],
    ['4 free throws', { ...base, type: 'foul', payload: { team: 'A', offender: 'player', player: 'a1', kind: 'shooting', freeThrows: 4 } }],
    ['empty substitution', { ...base, type: 'substitution', payload: { team: 'A', out: [], in: [] } }],
    ['amend of a correction', { ...base, type: 'amend', payload: { targetId: 'x', body: { type: 'void', payload: { targetId: 'y' } } } }],
    ['bad turnover kind', { ...base, type: 'turnover', payload: { team: 'A', kind: 'sneezed' } }],
  ])('%s', (_, input) => {
    expect(parseEvent(input).success).toBe(false);
  });
});
