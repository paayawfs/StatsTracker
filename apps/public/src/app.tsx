import { useSignal } from '@preact/signals';
import { formatClock, remaining, ZONES, type ShotZone, type Split, type Team, type ZoneGroup } from '@stats/core';
import { Avatar, Court } from '@stats/ui';
import { useEffect } from 'preact/hooks';
import { heat, minutes, pct, signed } from './format';
import { box, everOnline, events, game, now, online, open, plays, shots, splits, state, units, who, type PublicGame } from './viewer';

type Tab = 'box' | 'plays' | 'lineups' | 'onoff' | 'shots';

export function App() {
  const slug = location.pathname.match(/^\/g\/([0-9a-f]{32})\/?$/i)?.[1]?.toLowerCase();
  useEffect(() => {
    if (slug) void open(slug);
  }, [slug]);
  if (!slug || game.value === 'missing') return <p class="empty">Game not found. Check the link.</p>;
  if (game.value === 'unreachable') return <p class="empty">Can't reach the server. Retrying…</p>;
  if (!game.value) return <p class="empty">Loading…</p>;
  return <Game g={game.value} />;
}

function Game({ g }: { g: PublicGame }) {
  const tab = useSignal<Tab>('box');
  const tabs: [Tab, string][] = [
    ['box', 'Box score'],
    ['plays', 'Play-by-play'],
    ['lineups', 'Lineups'],
    ['onoff', 'On/Off'],
    ...(g.shotLocations ? [['shots', 'Shot chart'] as [Tab, string]] : []),
  ];
  return (
    <div class="viewer">
      <h1 class="sr-only">{g.teams.A} v {g.teams.B}: live stats</h1>
      <Header g={g} />
      <nav class="tabs">
        {tabs.map(([t, label]) => (
          <button key={t} class={tab.value === t ? 'on' : ''} aria-pressed={tab.value === t} onClick={() => (tab.value = t)}>
            {label}
          </button>
        ))}
      </nav>
      <main>
        {tab.value === 'box' && (['A', 'B'] as const).map((t) => <BoxTable key={t} g={g} team={t} />)}
        {tab.value === 'plays' && <Plays g={g} />}
        {tab.value === 'lineups' && (['A', 'B'] as const).map((t) => <Lineups key={t} g={g} team={t} />)}
        {tab.value === 'onoff' && (['A', 'B'] as const).map((t) => <OnOff key={t} g={g} team={t} />)}
        {tab.value === 'shots' && <Shots g={g} />}
      </main>
    </div>
  );
}

/** "P2", or "OT1" past regulation. */
const periodName = (period: number) => {
  const regulation = state.value.rules?.periods ?? 4;
  return period > regulation ? `OT${period - regulation}` : `P${period}`;
};

function Header({ g }: { g: PublicGame }) {
  const st = state.value;
  // A lock arrives as an event: the game is over for viewers even if the scorer never ended it.
  const final = st.phase === 'final' || g.locked || events.value.some((e) => e.type === 'adminLock');
  const status = final ? 'FINAL' : st.phase === 'pregame' ? 'Starts soon' : st.phase === 'break' ? `End of ${periodName(st.period)}` : periodName(st.period);
  useEffect(() => {
    document.title = st.phase === 'pregame' ? `${g.teams.A} v ${g.teams.B}` : `${g.teams.A} ${st.score.A}-${st.score.B} ${g.teams.B} · ${status}`;
  }, [st.score.A, st.score.B, status]);
  return (
    <header class="board" aria-label="Score">
      <div class="team team-A">
        <span>{g.teams.A}</span>
        <b data-testid="score-A" aria-live="polite">{st.score.A}</b>
      </div>
      <div class="status">
        <span class="clock">{st.phase === 'live' && !final ? formatClock(remaining(st.clock, now.value)) : ''}</span>
        <span>{status}</span>
        {!final && st.phase !== 'pregame' && <span class={online.value ? 'live' : 'stale'}>{online.value ? '● LIVE' : everOnline.value ? 'reconnecting…' : 'connecting…'}</span>}
      </div>
      <div class="team team-B">
        <span>{g.teams.B}</span>
        <b data-testid="score-B" aria-live="polite">{st.score.B}</b>
      </div>
    </header>
  );
}

const COLUMNS = ['MIN', 'PTS', 'FG', '3P', 'FT', 'OR', 'DR', 'REB', 'AST', 'TO', 'STL', 'BLK', 'PF', '+/-', 'EFF'];

function BoxTable({ g, team }: { g: PublicGame; team: Team }) {
  const b = box.value;
  const rows = b.players.filter((p) => p.team === team);
  const t = b.teams[team];
  const jersey = (id: string) => g.roster.find((p) => p.playerId === id);
  return (
    <section>
      <h2>{g.teams[team]}</h2>
      <div class="scroll">
        <table data-testid={`box-${team}`}>
          <thead>
            <tr>
              <th class="name">Player</th>
              {COLUMNS.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const r = jersey(p.playerId);
              return (
                <tr key={p.playerId} class={p.min || p.pts ? '' : 'dnp'}>
                  <td class="name">
                    <span class="who">
                      <Avatar name={r?.name ?? ''} photo={r?.photo} team={team} size={24} />
                      <b>{r?.jersey}</b> <span class="pn">{r?.name}</span>
                    </span>
                  </td>
                  <td>{minutes(p.min)}</td>
                  <td>{p.pts}</td>
                  <td>{p.fgm}-{p.fga}</td>
                  <td>{p.p3m}-{p.p3a}</td>
                  <td>{p.ftm}-{p.fta}</td>
                  <td>{p.oreb}</td>
                  <td>{p.dreb}</td>
                  <td>{p.reb}</td>
                  <td>{p.ast}</td>
                  <td>{p.to}</td>
                  <td>{p.stl}</td>
                  <td>{p.blk}</td>
                  <td>{p.pf}</td>
                  <td>{signed(p.plusMinus)}</td>
                  <td>{p.eff}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td class="name">Team</td>
              <td />
              <td>{t.pts}</td>
              <td>
                {t.fgm}-{t.fga} <small>{pct(t.fgm, t.fga)}</small>
              </td>
              <td>
                {t.p3m}-{t.p3a} <small>{pct(t.p3m, t.p3a)}</small>
              </td>
              <td>
                {t.ftm}-{t.fta} <small>{pct(t.ftm, t.fta)}</small>
              </td>
              <td>{t.oreb}</td>
              <td>{t.dreb}</td>
              <td title={`incl. ${t.teamReb} team`}>{t.reb}</td>
              <td>{t.ast}</td>
              <td title={`incl. ${t.teamTo} team`}>{t.to}</td>
              <td>{t.stl}</td>
              <td>{t.blk}</td>
              <td>{t.pf}</td>
              <td />
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="small team-extra">Points in the paint: <b>{t.pitp}</b> <span>(located shots in the restricted area or paint)</span></p>
    </section>
  );
}

function Plays({ g: _g }: { g: PublicGame }) {
  if (!plays.value.length) return <p class="small none">No plays yet. They appear here as they happen.</p>;
  return (
    <ol class="plays" data-testid="plays">
      {plays.value.map((r) => (
        <li key={r.event.id} class={r.scored ? `scored team-${r.scored}` : ''}>
          <span class="t">
            {periodName(r.event.period)} {r.event.type === 'periodEnd' || r.event.type === 'gameEnd' ? 'end' : formatClock(r.event.gameClock)}
          </span>
          <span class="text">{r.text}</span>
          <span class="s">
            {r.score.A}-{r.score.B}
          </span>
        </li>
      ))}
    </ol>
  );
}

const jerseys = (g: PublicGame, ids: string[]) => ids.map((id) => g.roster.find((p) => p.playerId === id)?.jersey ?? '?').join(' · ');
/** Per-40 rates on a few seconds of play are noise (+5000): shown from 2 minutes. */
const MIN_FOR_RATE = 2 * 60_000;
const rate = (s: Split) => (s.min >= MIN_FOR_RATE ? signed(s.per40, 1) : '-');

function Lineups({ g, team }: { g: PublicGame; team: Team }) {
  return (
    <section>
      <h2>{g.teams[team]} lineups</h2>
      <div class="scroll">
      <table>
        <thead>
          <tr>
            <th class="name">Unit (jerseys)</th>
            <th>MIN</th>
            <th>PTS</th>
            <th>OPP</th>
            <th>+/-</th>
            <th>+/- /40</th>
          </tr>
        </thead>
        <tbody>
          {units.value[team].map((u) => (
            <tr key={u.players.join()}>
              <td class="name">{jerseys(g, u.players)}</td>
              <td>{minutes(u.min)}</td>
              <td>{u.ptsFor}</td>
              <td>{u.ptsAgainst}</td>
              <td>{signed(u.plusMinus)}</td>
              <td>{rate(u)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}

function OnOff({ g, team }: { g: PublicGame; team: Team }) {
  return (
    <section>
      <h2>{g.teams[team]} on/off</h2>
      <div class="scroll">
      <table>
        <thead>
          <tr>
            <th class="name">Player</th>
            <th>ON MIN</th>
            <th>ON +/-</th>
            <th>OFF MIN</th>
            <th>OFF +/-</th>
            <th>/40 diff</th>
          </tr>
        </thead>
        <tbody>
          {splits.value
            .filter((p) => p.team === team && p.on.min > 0)
            .map((p) => (
              <tr key={p.playerId}>
                <td class="name">{who(p.playerId)}</td>
                <td>{minutes(p.on.min)}</td>
                <td>{signed(p.on.plusMinus)}</td>
                <td>{minutes(p.off.min)}</td>
                <td>{signed(p.off.plusMinus)}</td>
                <td>{p.on.per40 !== null && p.off.per40 !== null && p.on.min >= MIN_FOR_RATE && p.off.min >= MIN_FOR_RATE ? signed(p.on.per40 - p.off.per40, 1) : '-'}</td>
              </tr>
            ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}

const GROUPS: [ZoneGroup, string][] = [
  ['restricted', 'Restricted area'],
  ['paint', 'Paint (non-RA)'],
  ['midRange', 'Mid-range'],
  ['corner3', 'Corner 3'],
  ['aboveBreak3', 'Above-break 3'],
];

/** Section heat map on the court (made/att per section, coloured by FG%), shots on top, grouped table below. */
function Shots({ g }: { g: PublicGame }) {
  const filter = useSignal<Team | 'all'>('all');
  const c = shots.value;
  const split = (z: ShotZone) => (filter.value === 'all' ? { made: c.zones.A[z].made + c.zones.B[z].made, att: c.zones.A[z].att + c.zones.B[z].att } : c.zones[filter.value][z]);
  const fills: Partial<Record<ShotZone, string>> = {};
  const labels: Partial<Record<ShotZone, string>> = {};
  for (const { id } of ZONES) {
    const s = split(id);
    const color = heat(s.made, s.att);
    if (color) fills[id] = color;
    if (s.att) labels[id] = `${s.made}/${s.att}`;
  }
  return (
    <section class="shots">
      <div class="filters">
        {(['all', 'A', 'B'] as const).map((f) => (
          <button key={f} class={filter.value === f ? 'on' : ''} aria-pressed={filter.value === f} onClick={() => (filter.value = f)}>
            {f === 'all' ? 'Both teams' : g.teams[f]}
          </button>
        ))}
      </div>
      <div class="shots-layout">
        <Court id="viewer-court" testId="shot-chart" fills={fills} labels={labels} />
        <div class="scroll">
        <table>
          <thead>
            <tr>
              <th class="name">Zone</th>
              <th>{g.teams.A}</th>
              <th>{g.teams.B}</th>
            </tr>
          </thead>
          <tbody>
            {GROUPS.map(([z, label]) => (
              <tr key={z}>
                <td class="name">{label}</td>
                {(['A', 'B'] as const).map((t) => (
                  <td key={t}>
                    {c.groups[t][z].made}-{c.groups[t][z].att} <small>{pct(c.groups[t][z].made, c.groups[t][z].att)}</small>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
      <p class="small">Numbers on the court are made/attempted per section; colour runs from cold (blue) to hot (orange), stronger with more attempts. Scorers record the section of each shot, not an exact spot.</p>
    </section>
  );
}
