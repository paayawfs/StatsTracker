import { useSignal } from '@preact/signals';
import { boxScore, describe, eventsCsv, FIBA, formatClock, NBA, seasonTotals, summarize, type GameEvent, type GameLog, type RuleSet } from '@stats/core';
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import {
  addAdmin, addPlayers, addSeason, addTeam, adminWrite, codes, createCode, createGame, createLeague, db, download, gameLog, gameRoster, games, latency,
  leagues, parsePlayers, players, PUBLIC_URL, revokeCode, ruleSets, saveRuleSet, seasons, setJersey, teams, user,
  type GameRow, type League, type PlayerRow, type RuleSetRow, type Season, type TeamRow,
} from './data';

type Section = 'games' | 'teams' | 'seasons' | 'rules' | 'stats' | 'admins';

/** Small async-data hook: load(), then render; `reload` re-runs it. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const data = useSignal<T | null>(null);
  const error = useSignal('');
  const tick = useSignal(0);
  useEffect(() => {
    let live = true;
    load().then(
      (d) => live && (data.value = d),
      (e: Error) => live && (error.value = e.message),
    );
    return () => void (live = false);
  }, [...deps, tick.value]);
  return { data: data.value, error: error.value, reload: () => tick.value++ };
}

/** Run an action, surface its error, then refresh. */
function useAction() {
  const error = useSignal('');
  const busy = useSignal(false);
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    busy.value = true;
    error.value = '';
    try {
      await fn();
      after?.();
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = false;
    }
  };
  return { run, error: error.value, busy: busy.value };
}

const Err = ({ msg }: { msg: string }) => (msg ? <p class="error">{msg}</p> : null);

export function Admin() {
  if (!user.value) return <SignIn />;
  return <Leagues />;
}

function SignIn() {
  const email = useSignal('');
  const password = useSignal('');
  const { run, error, busy } = useAction();
  const go = (mode: 'in' | 'up') =>
    run(async () => {
      const creds = { email: email.value.trim(), password: password.value };
      const r = mode === 'in' ? await db.auth.signInWithPassword(creds) : await db.auth.signUp(creds);
      if (r.error) throw r.error;
      if (mode === 'up' && !r.data.session) throw new Error('Account created. Confirm it from the email we sent, then sign in.');
    });
  return (
    <form class="admin-auth" onSubmit={(e) => (e.preventDefault(), void go('in'))}>
      <h1>League admin</h1>
      <label for="admin-email">Email</label>
      <input id="admin-email" type="email" autocomplete="email" value={email.value} onInput={(e) => (email.value = e.currentTarget.value)} />
      <label for="admin-password">Password</label>
      <input id="admin-password" type="password" autocomplete="current-password" value={password.value} onInput={(e) => (password.value = e.currentTarget.value)} />
      <div class="row">
        <button class="primary" disabled={busy}>Sign in</button>
        <button type="button" disabled={busy} onClick={() => go('up')}>Create account</button>
      </div>
      <Err msg={error} />
    </form>
  );
}

function Leagues() {
  const current = useSignal<League | null>(null);
  const { data, error, reload } = useLoad(leagues, []);
  const name = useSignal('');
  const act = useAction();
  if (current.value) return <LeaguePage league={current.value} back={() => (current.value = null)} />;
  return (
    <div class="admin">
      <header class="admin-top">
        <h1>Your leagues</h1>
        <span class="small">{user.value?.email}</span>
        <button onClick={() => db.auth.signOut()}>Sign out</button>
      </header>
      <Err msg={error} />
      <ul class="list">
        {data?.map((l) => (
          <li key={l.id}>
            <button class="link-row" onClick={() => (current.value = l)}>{l.name}</button>
          </li>
        ))}
        {data?.length === 0 && <li class="small">No leagues yet. Create your first one below.</li>}
      </ul>
      <form class="row" onSubmit={(e) => (e.preventDefault(), void act.run(() => createLeague(name.value.trim()), () => ((name.value = ''), reload())))}>
        <input id="new-league" placeholder="League name" value={name.value} onInput={(e) => (name.value = e.currentTarget.value)} />
        <button class="primary" disabled={!name.value.trim() || act.busy}>Create league</button>
      </form>
      <Err msg={act.error} />
    </div>
  );
}

function LeaguePage({ league, back }: { league: League; back: () => void }) {
  const section = useSignal<Section>('games');
  const openGame = useSignal<string | null>(null);
  const tabs: [Section, string][] = [['games', 'Games'], ['teams', 'Teams & players'], ['seasons', 'Seasons'], ['rules', 'Rule sets'], ['stats', 'Season stats'], ['admins', 'Admins']];
  if (openGame.value) return <GamePage league={league} gameId={openGame.value} back={() => (openGame.value = null)} />;
  return (
    <div class="admin">
      <header class="admin-top">
        <button onClick={back}>‹ Leagues</button>
        <h1>{league.name}</h1>
      </header>
      <nav class="admin-tabs">
        {tabs.map(([s, label]) => (
          <button key={s} class={section.value === s ? 'on' : ''} onClick={() => (section.value = s)}>{label}</button>
        ))}
      </nav>
      {section.value === 'games' && <Games league={league} open={(id) => (openGame.value = id)} />}
      {section.value === 'teams' && <Teams league={league} />}
      {section.value === 'seasons' && <Seasons league={league} />}
      {section.value === 'rules' && <Rules league={league} />}
      {section.value === 'stats' && <SeasonStats league={league} />}
      {section.value === 'admins' && <Admins league={league} />}
    </div>
  );
}

function Games({ league, open }: { league: League; open: (id: string) => void }) {
  const { data, error, reload } = useLoad(async () => ({ games: await games(league.id), teams: await teams(league.id), seasons: await seasons(league.id), rules: await ruleSets(league.id) }), [league.id]);
  const form = useSignal({ team_a: '', team_b: '', season_id: '', rule_set_id: '', mode: 'single' as 'single' | 'multi', shot_locations: false, scheduled_at: '' });
  const act = useAction();
  if (!data) return <Err msg={error} />;
  const name = (id: string) => data.teams.find((t) => t.id === id)?.name ?? '?';
  const f = form.value;
  const set = (patch: Partial<typeof f>) => (form.value = { ...f, ...patch });
  const ready = f.team_a && f.team_b && f.rule_set_id && f.team_a !== f.team_b;
  return (
    <section>
      <table class="admin-table">
        <thead><tr><th>Game</th><th>Season</th><th>Mode</th><th>Status</th></tr></thead>
        <tbody>
          {data.games.map((g) => (
            <tr key={g.id}>
              <td><button class="link-row" onClick={() => open(g.id)}>{name(g.team_a)} vs {name(g.team_b)}</button> <span class="small">{g.scheduled_at ? new Date(g.scheduled_at).toLocaleString() : ''}</span></td>
              <td>{data.seasons.find((s) => s.id === g.season_id)?.name ?? '-'}</td>
              <td>{g.mode}{g.shot_locations ? ' · shots' : ''}</td>
              <td>{g.locked_at ? 'locked' : 'open'}</td>
            </tr>
          ))}
          {!data.games.length && <tr><td colSpan={4} class="small">No games yet.</td></tr>}
        </tbody>
      </table>
      <h2>New game</h2>
      {data.teams.length < 2 || !data.rules.length ? (
        <p class="small">Add at least two teams and one rule set first.</p>
      ) : (
        <form class="form-grid" onSubmit={(e) => (e.preventDefault(), void act.run(async () => open(await createGame(league.id, { ...f, season_id: f.season_id || null, scheduled_at: f.scheduled_at ? new Date(f.scheduled_at).toISOString() : null })), reload))}>
          <label for="g-a">Team A (home)</label>
          <select id="g-a" value={f.team_a} onChange={(e) => set({ team_a: e.currentTarget.value })}><option value="">Pick…</option>{data.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <label for="g-b">Team B (away)</label>
          <select id="g-b" value={f.team_b} onChange={(e) => set({ team_b: e.currentTarget.value })}><option value="">Pick…</option>{data.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <label for="g-season">Season</label>
          <select id="g-season" value={f.season_id} onChange={(e) => set({ season_id: e.currentTarget.value })}><option value="">None</option>{data.seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <label for="g-rules">Rule set</label>
          <select id="g-rules" value={f.rule_set_id} onChange={(e) => set({ rule_set_id: e.currentTarget.value })}><option value="">Pick…</option>{data.rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          <label for="g-mode">Scoring</label>
          <select id="g-mode" value={f.mode} onChange={(e) => set({ mode: e.currentTarget.value as 'single' | 'multi' })}><option value="single">One device</option><option value="multi">Several devices (team A, team B, clock)</option></select>
          <label for="g-when">Tip-off</label>
          <input id="g-when" type="datetime-local" value={f.scheduled_at} onInput={(e) => set({ scheduled_at: e.currentTarget.value })} />
          <label class="check"><input id="g-shots" type="checkbox" checked={f.shot_locations} onChange={(e) => set({ shot_locations: e.currentTarget.checked })} /> Record shot locations</label>
          <button class="primary" disabled={!ready || act.busy}>Create game</button>
        </form>
      )}
      <Err msg={act.error} />
    </section>
  );
}

function Teams({ league }: { league: League }) {
  const { data, error, reload } = useLoad(async () => {
    const t = await teams(league.id);
    return { teams: t, players: await players(t.map((x) => x.id)) };
  }, [league.id]);
  const newTeam = useSignal('');
  const paste = useSignal<Record<string, string>>({});
  const act = useAction();
  if (!data) return <Err msg={error} />;
  return (
    <section>
      <form class="row" onSubmit={(e) => (e.preventDefault(), void act.run(() => addTeam(league.id, newTeam.value.trim()), () => ((newTeam.value = ''), reload())))}>
        <input id="new-team" placeholder="Team name" value={newTeam.value} onInput={(e) => (newTeam.value = e.currentTarget.value)} />
        <button class="primary" disabled={!newTeam.value.trim() || act.busy}>Add team</button>
      </form>
      <Err msg={act.error || error} />
      <div class="team-cards">
        {data.teams.map((t) => (
          <TeamCard key={t.id} team={t} players={data.players.filter((p) => p.team_id === t.id)} text={paste.value[t.id] ?? ''}
            onText={(s) => (paste.value = { ...paste.value, [t.id]: s })}
            onAdd={() => act.run(() => addPlayers(t.id, parsePlayers(paste.value[t.id] ?? '')), () => ((paste.value = { ...paste.value, [t.id]: '' }), reload()))} />
        ))}
      </div>
    </section>
  );
}

function TeamCard({ team, players: ps, text, onText, onAdd }: { team: TeamRow; players: PlayerRow[]; text: string; onText: (s: string) => void; onAdd: () => void }) {
  const sorted = [...ps].sort((a, b) => Number(a.default_jersey ?? 999) - Number(b.default_jersey ?? 999));
  return (
    <article class="team-card" data-testid={`team-${team.name}`}>
      <h3>{team.name} <span class="small">{ps.length} players</span></h3>
      <ol class="roster-list">
        {sorted.map((p) => <li key={p.id}><b>{p.default_jersey ?? '–'}</b> {p.name}</li>)}
      </ol>
      <label for={`paste-${team.id}`} class="small">Add players, one per line: "23 Kofi Mensah"</label>
      <textarea id={`paste-${team.id}`} rows={4} value={text} onInput={(e) => onText(e.currentTarget.value)} />
      <button onClick={onAdd} disabled={!parsePlayers(text).length}>Add {parsePlayers(text).length || ''} players</button>
    </article>
  );
}

function Seasons({ league }: { league: League }) {
  const { data, error, reload } = useLoad(() => seasons(league.id), [league.id]);
  const name = useSignal('');
  const act = useAction();
  return (
    <section>
      <ul class="list">{data?.map((s) => <li key={s.id}>{s.name}</li>)}</ul>
      <form class="row" onSubmit={(e) => (e.preventDefault(), void act.run(() => addSeason(league.id, name.value.trim()), () => ((name.value = ''), reload())))}>
        <input id="new-season" placeholder="Season name, e.g. 2026/27" value={name.value} onInput={(e) => (name.value = e.currentTarget.value)} />
        <button class="primary" disabled={!name.value.trim() || act.busy}>Add season</button>
      </form>
      <Err msg={act.error || error} />
    </section>
  );
}

const MIN = 60_000;

function Rules({ league }: { league: League }) {
  const { data, error, reload } = useLoad(() => ruleSets(league.id), [league.id]);
  const editing = useSignal<{ id?: string; rules: RuleSet } | null>(null);
  const act = useAction();
  const e = editing.value;
  const set = (patch: Partial<RuleSet>) => e && (editing.value = { ...e, rules: { ...e.rules, ...patch } });
  const num = (label: string, id: string, value: number, apply: (n: number) => void, step = 1) => (
    <>
      <label for={id}>{label}</label>
      <input id={id} type="number" min={0} step={step} value={value} onInput={(ev) => apply(Number(ev.currentTarget.value))} />
    </>
  );
  return (
    <section>
      <ul class="list">
        {data?.map((r: RuleSetRow) => (
          <li key={r.id}><button class="link-row" onClick={() => (editing.value = { id: r.id, rules: r.rules })}>{r.name}</button> <span class="small">{r.rules.periods} × {r.rules.periodLengthMs / MIN} min · {r.rules.personalFoulLimit} fouls</span></li>
        ))}
      </ul>
      <div class="row">
        <button onClick={() => (editing.value = { rules: { ...FIBA } })}>New from FIBA</button>
        <button onClick={() => (editing.value = { rules: { ...NBA } })}>New from NBA</button>
      </div>
      {e && (
        <form class="form-grid" onSubmit={(ev) => (ev.preventDefault(), void act.run(() => saveRuleSet(league.id, e.rules, e.id), () => ((editing.value = null), reload())))}>
          <label for="r-name">Name</label>
          <input id="r-name" value={e.rules.name} onInput={(ev) => set({ name: ev.currentTarget.value })} />
          {num('Periods', 'r-periods', e.rules.periods, (n) => set({ periods: n }))}
          {num('Period length (min)', 'r-len', e.rules.periodLengthMs / MIN, (n) => set({ periodLengthMs: Math.round(n * MIN) }), 0.5)}
          {num('Overtime length (min)', 'r-ot', e.rules.overtimeLengthMs / MIN, (n) => set({ overtimeLengthMs: Math.round(n * MIN) }), 0.5)}
          {num('Personal fouls to foul out', 'r-pf', e.rules.personalFoulLimit, (n) => set({ personalFoulLimit: n }))}
          {num('Team fouls before bonus', 'r-bonus', e.rules.teamFoulBonus.threshold, (n) => set({ teamFoulBonus: { ...e.rules.teamFoulBonus, threshold: n } }))}
          {num('Bonus free throws', 'r-bft', e.rules.teamFoulBonus.freeThrows, (n) => set({ teamFoulBonus: { ...e.rules.teamFoulBonus, freeThrows: n } }))}
          {num('Overtime timeouts', 'r-ott', e.rules.overtimeTimeouts, (n) => set({ overtimeTimeouts: n }))}
          <p class="small span">Timeout windows: {e.rules.timeouts.map((w) => `${w.count} in periods ${w.periods.join('-')}`).join(', ')} (from the preset).</p>
          <button class="primary">Save rule set</button>
          <button type="button" onClick={() => (editing.value = null)}>Cancel</button>
        </form>
      )}
      <Err msg={act.error || error} />
    </section>
  );
}

function Admins({ league }: { league: League }) {
  const email = useSignal('');
  const msg = useSignal('');
  const act = useAction();
  return (
    <section>
      <p class="small">Admins can create games, fix the log after a game and export data. They need an account first.</p>
      <form class="row" onSubmit={(e) => (e.preventDefault(), void act.run(async () => {
        const ok = await addAdmin(league.id, email.value);
        msg.value = ok ? `${email.value} is now an admin of ${league.name}.` : `No account uses ${email.value}. Ask them to create one at /admin first.`;
        email.value = '';
      }))}>
        <input id="admin-add" type="email" placeholder="colleague@example.com" value={email.value} onInput={(e) => (email.value = e.currentTarget.value)} />
        <button class="primary" disabled={!email.value || act.busy}>Add admin</button>
      </form>
      {msg.value && <p>{msg.value}</p>}
      <Err msg={act.error} />
    </section>
  );
}

function SeasonStats({ league }: { league: League }) {
  const seasonId = useSignal('');
  const { data: meta } = useLoad(async () => ({ seasons: await seasons(league.id), teams: await teams(league.id) }), [league.id]);
  const { data, error } = useLoad(async () => {
    if (!seasonId.value) return null;
    const gs = (await games(league.id)).filter((g) => g.season_id === seasonId.value);
    const logs = await Promise.all(gs.map(async (g) => ({ gameId: g.id, teams: { A: g.team_a, B: g.team_b }, events: (await gameLog(g.id)).events })));
    const ps = await players([...new Set(gs.flatMap((g) => [g.team_a, g.team_b]))]);
    return { totals: seasonTotals(logs), players: ps, games: gs.length };
  }, [league.id, seasonId.value]);
  const teamName = (id: string) => meta?.teams.find((t: TeamRow) => t.id === id)?.name ?? '?';
  const f1 = (n: number) => n.toFixed(1);
  return (
    <section>
      <label for="stats-season">Season </label>
      <select id="stats-season" value={seasonId.value} onChange={(e) => (seasonId.value = e.currentTarget.value)}>
        <option value="">Pick a season…</option>
        {meta?.seasons.map((s: Season) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <Err msg={error} />
      {data && (
        <>
          <h2>Standings <span class="small">{data.games} games</span></h2>
          <table class="admin-table num">
            <thead><tr><th>Team</th><th>GP</th><th>W</th><th>L</th><th>PTS</th><th>OPP</th><th>PPG</th></tr></thead>
            <tbody>
              {[...data.totals.teams].sort((a, b) => b.wins - a.wins || b.pts - b.ptsAgainst - (a.pts - a.ptsAgainst)).map((t) => (
                <tr key={t.teamId}><td>{teamName(t.teamId)}</td><td>{t.gp}</td><td>{t.wins}</td><td>{t.losses}</td><td>{t.pts}</td><td>{t.ptsAgainst}</td><td>{t.gp ? f1(t.pts / t.gp) : '-'}</td></tr>
              ))}
            </tbody>
          </table>
          <h2>Players</h2>
          <div class="scroll">
            <table class="admin-table num" data-testid="season-players">
              <thead><tr><th>Player</th><th>Team</th><th>GP</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th><th>FG</th><th>3P</th><th>FT</th><th>EFF</th></tr></thead>
              <tbody>
                {data.totals.players.filter((p) => p.gp).sort((a, b) => b.perGame.pts - a.perGame.pts).map((p) => {
                  const row = data.players.find((x) => x.id === p.playerId);
                  return (
                    <tr key={p.playerId}>
                      <td>{row?.name ?? p.playerId}</td><td>{row ? teamName(row.team_id) : ''}</td><td>{p.gp}</td>
                      <td>{f1(p.perGame.min / MIN)}</td><td>{f1(p.perGame.pts)}</td><td>{f1(p.perGame.reb)}</td><td>{f1(p.perGame.ast)}</td>
                      <td>{f1(p.perGame.stl)}</td><td>{f1(p.perGame.blk)}</td><td>{f1(p.perGame.to)}</td>
                      <td>{p.fgm}-{p.fga}</td><td>{p.p3m}-{p.p3a}</td><td>{p.ftm}-{p.fta}</td><td>{f1(p.perGame.eff)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p class="small">Per-game averages; FG/3P/FT are season totals.</p>
        </>
      )}
    </section>
  );
}

function GamePage({ league, gameId, back }: { league: League; gameId: string; back: () => void }) {
  const { data, error, reload } = useLoad(async () => {
    const g = (await games(league.id)).find((x) => x.id === gameId)!;
    const t = await teams(league.id);
    return { game: g, teams: t, roster: await gameRoster(gameId), players: await players([g.team_a, g.team_b]), codes: await codes(gameId), log: await gameLog(gameId), latency: await latency(gameId) };
  }, [gameId]);
  const act = useAction();
  const confirmLock = useSignal(false);
  if (!data) return <div class="admin"><button onClick={back}>‹ Games</button><Err msg={error} /></div>;
  const { game, log } = data;
  const name = (id: string) => data.teams.find((t) => t.id === id)?.name ?? '?';
  const st = log.state;
  const started = st.phase !== 'pregame';
  const who = (id?: string) => {
    const r = data.roster.find((x) => x.player_id === id);
    const p = data.players.find((x) => x.id === id);
    return p ? `#${r?.jersey ?? ''} ${p.name}` : 'team';
  };
  const file = `${name(game.team_a)}-vs-${name(game.team_b)}`.replace(/\W+/g, '-');
  return (
    <div class="admin">
      <header class="admin-top">
        <button onClick={back}>‹ Games</button>
        <h1>{name(game.team_a)} {st.score.A} – {st.score.B} {name(game.team_b)}</h1>
        <span class="pill">{game.locked_at ? 'Locked' : st.phase === 'final' ? 'Final (not locked)' : started ? `Live · P${st.period}` : 'Not started'}</span>
      </header>
      <Err msg={act.error || error} />

      <Panel title="Scorers and viewers">
        <p>Viewer link: <code>{`${PUBLIC_URL}/g/${game.public_slug}`}</code></p>
        <table class="admin-table">
          <thead><tr><th>Scorer code</th><th>Valid until</th><th /></tr></thead>
          <tbody>
            {data.codes.map((c) => (
              <tr key={c.code}>
                <td><code class="code">{c.code}</code></td>
                <td>{c.revoked_at ? 'revoked' : new Date(c.expires_at).toLocaleString()}</td>
                <td>{!c.revoked_at && <button onClick={() => act.run(() => revokeCode(c.code), reload)}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!game.locked_at && <button class="primary" onClick={() => act.run(() => createCode(gameId), reload)}>New scorer code</button>}
      </Panel>

      <Panel title={`Roster ${started ? '(locked once the game starts)' : ''}`}>
        <div class="team-cards">
          {(['A', 'B'] as const).map((t) => (
            <article key={t} class="team-card">
              <h3>{name(t === 'A' ? game.team_a : game.team_b)}</h3>
              {data.roster.filter((r) => r.team === t).sort((a, b) => Number(a.jersey) - Number(b.jersey)).map((r) => (
                <div key={r.player_id} class="row">
                  <input id={`j-${r.player_id}`} aria-label="Jersey" class="jersey" value={r.jersey} disabled={started}
                    onChange={(e) => act.run(() => setJersey(gameId, r.player_id, e.currentTarget.value.trim()), reload)} />
                  <span>{data.players.find((p) => p.id === r.player_id)?.name}</span>
                </div>
              ))}
            </article>
          ))}
        </div>
      </Panel>

      <Panel title="Lock and export">
        <div class="row">
          {!game.locked_at && (confirmLock.value ? (
            <>
              <span>Lock the game? Scorers can no longer write; only admins can correct it.</span>
              <button class="danger" onClick={() => act.run(() => adminWrite(log, gameId, { type: 'adminLock', payload: {} }), () => ((confirmLock.value = false), reload()))}>Lock game</button>
              <button onClick={() => (confirmLock.value = false)}>Cancel</button>
            </>
          ) : (
            <button onClick={() => (confirmLock.value = true)}>Lock game…</button>
          ))}
          <button onClick={() => download(`${file}.csv`, eventsCsv(log.events), 'text/csv')}>Export CSV</button>
          <button onClick={() => download(`${file}.json`, JSON.stringify(log.events, null, 2), 'application/json')}>Export JSON</button>
        </div>
        <p class="small">{log.events.length} events. Exports are the corrected log (corrections applied, correction markers included).</p>
      </Panel>

      <Panel title="Latency">
        <Latency rows={data.latency} />
      </Panel>

      <Panel title="Play-by-play and corrections">
        <Corrections log={log} who={who} fix={(body) => act.run(() => adminWrite(log, gameId, body), reload)} />
      </Panel>
      <p class="small">Box score: {boxScore(log.events).players.filter((p) => p.pts).map((p) => `${who(p.playerId)} ${p.pts}`).join(' · ') || 'no points yet'}</p>
    </div>
  );
}

function Latency({ rows }: { rows: { device_id: string; kind: 'render' | 'peer'; ms: number }[] }) {
  const BUDGET = { render: 50, peer: 300 };
  const devices = [...new Set(rows.map((r) => r.device_id))];
  if (!rows.length) return <p class="small">No samples yet. Scorer devices upload them every 15 seconds.</p>;
  const line = (label: string, kind: 'render' | 'peer', filter: (r: (typeof rows)[number]) => boolean) => {
    const s = summarize(rows.filter((r) => r.kind === kind && filter(r)).map((r) => r.ms));
    if (!s.n) return null;
    const over = (s.p95 ?? 0) > BUDGET[kind];
    return (
      <tr key={label + kind}>
        <td>{label}</td><td>{kind === 'render' ? 'tap → own screen' : 'tap → other device'}</td><td>{s.n}</td>
        <td>{s.p50?.toFixed(0)}</td><td class={over ? 'bad' : 'good'}>{s.p95?.toFixed(0)}</td><td>{s.max?.toFixed(0)}</td><td>{BUDGET[kind]}</td>
      </tr>
    );
  };
  return (
    <table class="admin-table num" data-testid="latency">
      <thead><tr><th>Device</th><th>Path</th><th>n</th><th>median ms</th><th>p95 ms</th><th>max ms</th><th>budget</th></tr></thead>
      <tbody>
        {line('All devices', 'render', () => true)}
        {line('All devices', 'peer', () => true)}
        {devices.flatMap((d) => [line(`…${d.slice(-6)}`, 'render', (r) => r.device_id === d), line(`…${d.slice(-6)}`, 'peer', (r) => r.device_id === d)])}
      </tbody>
    </table>
  );
}

function Corrections({ log, who, fix }: { log: GameLog; who: (id?: string) => string; fix: (body: Parameters<typeof adminWrite>[2]) => void }) {
  const open = useSignal<string | null>(null);
  const HIDE = new Set(['roleClaim', 'roleRelease', 'roleTransfer', 'amend', 'void', 'gameStart', 'clockStart', 'clockStop']);
  const rows = [...log.events].reverse().filter((e) => !HIDE.has(e.type));
  const flags = new Map<string, string[]>();
  for (const f of log.state.flags) flags.set(f.eventId, [...(flags.get(f.eventId) ?? []), f.code]);
  return (
    <div class="pbp-admin">
      {log.state.flags.length > 0 && <p class="small">{log.state.flags.length} data-quality flags (marked ⚑).</p>}
      {rows.map((e: GameEvent) => (
        <div key={e.id} class="row-event" onClick={() => (open.value = open.value === e.id ? null : e.id)}>
          <span class="t">P{e.period} {formatClock(e.gameClock)}</span>
          <span>{describe(e, who)}{flags.has(e.id) && <b class="flag" title={flags.get(e.id)!.join(', ')}> ⚑ {flags.get(e.id)!.join(', ')}</b>}</span>
          {open.value === e.id && (
            <span class="row-actions">
              <button onClick={() => fix({ type: 'void', payload: { targetId: e.id } })}>Remove</button>
              {e.type === 'shot' && <button onClick={() => fix({ type: 'amend', payload: { targetId: e.id, body: { type: 'shot', payload: { ...e.payload, made: !e.payload.made, ...(e.payload.made ? { assist: undefined } : { block: undefined }) } } } })}>{e.payload.made ? 'Mark missed' : 'Mark made'}</button>}
              {e.type === 'shot' && <button onClick={() => fix({ type: 'amend', payload: { targetId: e.id, body: { type: 'shot', payload: { ...e.payload, value: e.payload.value === 2 ? 3 : 2 } } } })}>Make it {e.payload.value === 2 ? 3 : 2}PT</button>}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export type { GameRow };
