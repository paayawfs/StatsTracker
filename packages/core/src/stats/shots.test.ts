import { describe, expect, test } from 'vitest';
import { ev, gameStart, periodStart } from '../test-helpers';
import { shotChart } from './shots';

describe('shotChart', () => {
  const events = [
    gameStart(),
    periodStart(),
    ev('shot', { shooter: 'a1', value: 2, made: true, x: 0.5, y: 0.1 }),
    ev('shot', { shooter: 'a1', value: 3, made: false, x: 0.03, y: 0.07 }),
    ev('shot', { shooter: 'b2', value: 3, made: true, x: 0.5, y: 0.75 }),
    ev('shot', { shooter: 'b2', value: 2, made: true }), // no location: not charted
  ];
  const chart = shotChart(events);

  test('only located shots are charted, with team and zone', () => {
    expect(chart.shots.map((s) => [s.shooter, s.team, s.zone, s.made])).toEqual([
      ['a1', 'A', 'paint', true],
      ['a1', 'A', 'corner3', false],
      ['b2', 'B', 'aboveBreak3', true],
    ]);
  });

  test('zone splits per team', () => {
    expect(chart.zones.A.paint).toEqual({ made: 1, att: 1 });
    expect(chart.zones.A.corner3).toEqual({ made: 0, att: 1 });
    expect(chart.zones.B.aboveBreak3).toEqual({ made: 1, att: 1 });
    expect(chart.zones.B.midRange).toEqual({ made: 0, att: 0 });
  });

  test('corrections are respected (the chart reads the effective log)', () => {
    expect(shotChart([gameStart(), periodStart()]).shots).toEqual([]);
  });
});
