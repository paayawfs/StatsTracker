import { shotZone, type ShotZone } from '../court';
import type { GameEvent, Team } from '../events';
import { walk } from './walk';

export interface ChartedShot {
  id: string;
  shooter: string;
  team: Team;
  x: number;
  y: number;
  value: 2 | 3;
  made: boolean;
  zone: ShotZone;
  period: number;
  gameClock: number;
}

export interface ShotChart {
  shots: ChartedShot[];
  zones: Record<Team, Record<ShotZone, { made: number; att: number }>>;
}

const emptyZones = () => ({
  paint: { made: 0, att: 0 },
  midRange: { made: 0, att: 0 },
  corner3: { made: 0, att: 0 },
  aboveBreak3: { made: 0, att: 0 },
});

/** Shots with a court location, plus made/attempted per zone and team. Unlocated shots are skipped. */
export function shotChart(events: readonly GameEvent[]): ShotChart {
  const chart: ShotChart = { shots: [], zones: { A: emptyZones(), B: emptyZones() } };
  for (const { event: e, before } of walk(events)) {
    if (e.type !== 'shot' || e.payload.x === undefined || e.payload.y === undefined) continue;
    const team = before.roster[e.payload.shooter];
    if (!team) continue;
    const zone = shotZone(e.payload.x, e.payload.y);
    chart.shots.push({ id: e.id, shooter: e.payload.shooter, team, x: e.payload.x, y: e.payload.y, value: e.payload.value, made: e.payload.made, zone, period: e.period, gameClock: e.gameClock });
    chart.zones[team][zone].att++;
    if (e.payload.made) chart.zones[team][zone].made++;
  }
  return chart;
}
