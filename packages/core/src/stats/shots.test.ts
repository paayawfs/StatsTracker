import { describe, expect, test } from 'vitest';
import { ev, gameStart, periodStart } from '../test-helpers';
import { shotChart } from './shots';

describe('shotChart', () => {
  const events = [
    gameStart(),
    periodStart(),
    ev('shot', { shooter: 'a1', value: 2, made: true, x: 0.5, y: 0.1 }), // restricted area
    ev('shot', { shooter: 'a1', value: 3, made: false, x: 0.03, y: 0.07 }), // left corner three
    ev('shot', { shooter: 'b2', value: 3, made: true, x: 0.5, y: 0.75 }), // top three
    ev('shot', { shooter: 'b2', value: 2, made: true }), // no location: not charted
  ];
  const chart = shotChart(events);

  test('only located shots are charted, with team and section', () => {
    expect(chart.shots.map((s) => [s.shooter, s.team, s.zone, s.made])).toEqual([
      ['a1', 'A', 'restricted', true],
      ['a1', 'A', 'corner3Left', false],
      ['b2', 'B', 'top3', true],
    ]);
  });

  test('section splits per team, every section present', () => {
    expect(chart.zones.A.restricted).toEqual({ made: 1, att: 1 });
    expect(chart.zones.A.corner3Left).toEqual({ made: 0, att: 1 });
    expect(chart.zones.B.top3).toEqual({ made: 1, att: 1 });
    expect(Object.keys(chart.zones.B)).toHaveLength(12);
  });

  test('grouped splits (NBA basic zones)', () => {
    expect(chart.groups.A.restricted).toEqual({ made: 1, att: 1 });
    expect(chart.groups.A.corner3).toEqual({ made: 0, att: 1 });
    expect(chart.groups.B.aboveBreak3).toEqual({ made: 1, att: 1 });
  });

  test('no shots, no chart', () => {
    expect(shotChart([gameStart(), periodStart()]).shots).toEqual([]);
  });
});
