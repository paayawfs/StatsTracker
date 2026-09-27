import { describe, expect, test } from 'vitest';
import { fixture } from './fixture';
import { describe as text, playByPlay } from './pbp';

const who = (id?: string) => (id ? id.toUpperCase() : 'team');

describe('playByPlay', () => {
  const rows = playByPlay(fixture(), who);

  test('game events with running score; no session or correction markers', () => {
    expect(rows.map((r) => r.text)).toEqual([
      'Start of period 1',
      'A1 3PT made, assist A2',
      'B1 2PT missed, blocked by A3',
      'A4 defensive rebound',
      'A2 turnover (bad pass), steal B2',
      'B3 shooting foul on A1, 2 FT',
      'A1 FT 1/2 made',
      'Sub A: out A5; in A6',
      'A1 FT 2/2 missed',
      'team defensive rebound',
      'B4 2PT made',
      'End of period 1',
    ]);
    expect(rows.find((r) => r.text.startsWith('B4'))!.score).toEqual({ A: 4, B: 2 });
  });

  test('scoring rows are marked with the team that scored', () => {
    expect(rows.filter((r) => r.scored).map((r) => r.scored)).toEqual(['A', 'A', 'B']);
  });
});

describe('describe', () => {
  test('coach foul', () => {
    const e = { type: 'foul', payload: { team: 'B', offender: 'coach', kind: 'technical', freeThrows: 1 } } as never;
    expect(text(e, who)).toBe('B coach technical foul, 1 FT');
  });

  test('team names when given', () => {
    const teams = { A: 'Lions', B: 'Tigers' };
    expect(text({ type: 'timeout', payload: { team: 'B' } } as never, who, teams)).toBe('Timeout Tigers');
    expect(text({ type: 'foul', payload: { team: 'A', offender: 'bench', kind: 'technical', freeThrows: 1 } } as never, who, teams)).toBe('Lions bench technical foul, 1 FT');
  });
});
