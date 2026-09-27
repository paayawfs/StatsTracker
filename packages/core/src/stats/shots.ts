import { shotZone, zoneGroup, ZONES, type ShotZone, type ZoneGroup } from '../court';
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

type Split = { made: number; att: number };
export interface ShotChart {
  shots: ChartedShot[];
  /** Per team, per section (all 12 present). */
  zones: Record<Team, Record<ShotZone, Split>>;
  /** Per team, per NBA basic zone. */
  groups: Record<Team, Record<ZoneGroup, Split>>;
}

const emptyZones = () => Object.fromEntries(ZONES.map((z) => [z.id, { made: 0, att: 0 }])) as Record<ShotZone, Split>;
const emptyGroups = (): Record<ZoneGroup, Split> => ({ rim: { made: 0, att: 0 }, shortMid: { made: 0, att: 0 }, longMid: { made: 0, att: 0 }, corner3: { made: 0, att: 0 }, aboveBreak3: { made: 0, att: 0 } });

/** Shots with a court location, plus made/attempted per zone and team. Unlocated shots are skipped. */
export function shotChart(events: readonly GameEvent[]): ShotChart {
  const chart: ShotChart = { shots: [], zones: { A: emptyZones(), B: emptyZones() }, groups: { A: emptyGroups(), B: emptyGroups() } };
  for (const { event: e, before } of walk(events)) {
    if (e.type !== 'shot' || e.payload.x === undefined || e.payload.y === undefined) continue;
    const team = before.roster[e.payload.shooter];
    if (!team) continue;
    const zone = shotZone(e.payload.x, e.payload.y);
    chart.shots.push({ id: e.id, shooter: e.payload.shooter, team, x: e.payload.x, y: e.payload.y, value: e.payload.value, made: e.payload.made, zone, period: e.period, gameClock: e.gameClock });
    for (const split of [chart.zones[team][zone], chart.groups[team][zoneGroup(zone)]]) {
      split.att++;
      if (e.payload.made) split.made++;
    }
  }
  return chart;
}
