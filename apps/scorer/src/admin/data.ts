import { signal } from '@preact/signals';
import { FIBA, GameLog, parseEvent, RuleSetSchema, type EventBody, type GameEvent, type RuleSet, type Team } from '@stats/core';
import { createClient, type User } from '@supabase/supabase-js';
import * as v from 'valibot';
import { firstLast } from '../logic/names';

const LOCAL_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

/** Admin client with its own session storage, so an admin signing in never replaces a scorer's anonymous session. */
export const db = createClient(import.meta.env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:54321', import.meta.env.VITE_SUPABASE_ANON_KEY ?? LOCAL_ANON, {
  auth: { storageKey: 'stats-admin-auth' },
});
export const PUBLIC_URL: string = import.meta.env.VITE_PUBLIC_URL ?? 'http://localhost:5174';

export const user = signal<User | null>(null);
void db.auth.getSession().then(({ data }) => (user.value = data.session?.user ?? null));
db.auth.onAuthStateChange((_, session) => (user.value = session?.user ?? null));

/** Throw the Supabase error, return the data. */
export function must<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

/** Delete a row; if something still uses it (a foreign key), say what in plain words. */
async function remove(table: string, id: string, inUse: string) {
  const { error } = await db.from(table).delete().eq('id', id);
  if (error) throw new Error(error.code === '23503' ? inUse : error.message);
}

export interface League { id: string; name: string }
export interface Season { id: string; name: string }
export interface TeamRow { id: string; name: string }
export interface PlayerRow { id: string; team_id: string; name: string; default_jersey: string | null; photo: string | null }
export interface RuleSetRow { id: string; name: string; rules: RuleSet }
export interface GameRow {
  id: string;
  team_a: string;
  team_b: string;
  season_id: string | null;
  rule_set_id: string;
  mode: 'single' | 'multi';
  shot_locations: boolean;
  public_slug: string;
  scheduled_at: string | null;
  locked_at: string | null;
}
export interface RosterRow { player_id: string; team: Team; jersey: string }

export const leagues = async () => must(await db.from('leagues').select('id, name').order('name')) as League[];
export const createLeague = async (name: string) => must(await db.rpc('create_league', { league_name: name })) as string;
export const addAdmin = async (league: string, email: string) => must(await db.rpc('add_league_admin', { league, admin_email: email })) as boolean;

export const seasons = async (league: string) => must(await db.from('seasons').select('id, name').eq('league_id', league).order('name')) as Season[];
/** Names compare ignoring case and extra spaces ("lions" is "Lions"). */
const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

export async function addSeason(league: string, name: string) {
  if ((await seasons(league)).some((s) => sameName(s.name, name))) throw new Error(`There is already a season called ${name.trim()}.`);
  return must(await db.from('seasons').insert({ league_id: league, name: name.trim() }).select().single());
}

export const teams = async (league: string) => must(await db.from('teams').select('id, name').eq('league_id', league).order('name')) as TeamRow[];
export async function renameSeason(league: string, id: string, name: string) {
  if ((await seasons(league)).some((s) => s.id !== id && sameName(s.name, name))) throw new Error(`There is already a season called ${name.trim()}.`);
  must(await db.from('seasons').update({ name: name.trim() }).eq('id', id).select());
}
export const deleteSeason = (id: string) => remove('seasons', id, 'This season has games. Move or delete them first.');

export async function renameTeam(league: string, id: string, name: string) {
  if ((await teams(league)).some((t) => t.id !== id && sameName(t.name, name))) throw new Error(`There is already a team called ${name.trim()}.`);
  must(await db.from('teams').update({ name: name.trim() }).eq('id', id).select());
}
/** Deletes the team's players too. Refused if the team has games. */
export const deleteTeam = (id: string) => remove('teams', id, 'This team has games, so it stays (its stats are part of them).');

export async function addTeam(league: string, name: string) {
  if ((await teams(league)).some((t) => sameName(t.name, name))) throw new Error(`There is already a team called ${name.trim()}.`);
  return must(await db.from('teams').insert({ league_id: league, name: name.trim() }).select('id, name').single()) as TeamRow;
}
export const players = async (teamIds: string[]) =>
  (teamIds.length ? must(await db.from('players').select('id, team_id, name, default_jersey, photo').in('team_id', teamIds).order('name')) : []) as PlayerRow[];

/** Parse pasted lines like "23 Kofi Mensah" or "Kofi Mensah" into players. */
export function parsePlayers(text: string): { name: string; default_jersey: string | null }[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^#?(\d{1,2})\s*[-.,:]?\s+(.+)$/);
      return m ? { name: firstLast(m[2]!), default_jersey: m[1]! } : { name: firstLast(l), default_jersey: null };
    });
}
/** Why these new players can't join a team that already has `existing`, or null. */
export function newPlayersProblem(rows: { name: string; default_jersey: string | null }[], existing: { name: string; default_jersey: string | null }[]): string | null {
  const key = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const names = new Set(existing.map((p) => key(p.name)));
  const shirts = new Map(existing.filter((p) => p.default_jersey).map((p) => [p.default_jersey!, p.name]));
  for (const r of rows) {
    if (names.has(key(r.name))) return `${r.name} is already on this team.`;
    names.add(key(r.name));
    if (r.default_jersey) {
      const holder = shirts.get(r.default_jersey);
      if (holder) return `#${r.default_jersey} is already ${holder}'s number.`;
      shirts.set(r.default_jersey, r.name);
    }
  }
  return null;
}

export async function updatePlayer(team: string, id: string, p: { name: string; default_jersey: string | null }) {
  const problem = newPlayersProblem([p], (await players([team])).filter((x) => x.id !== id));
  if (problem) throw new Error(problem);
  must(await db.from('players').update({ name: p.name.trim(), default_jersey: p.default_jersey }).eq('id', id).select());
}
export const deletePlayer = (id: string) => remove('players', id, 'This player is on a game roster, so they stay (their stats are part of it).');

export async function addPlayers(team: string, rows: { name: string; default_jersey: string | null }[]) {
  const problem = newPlayersProblem(rows, await players([team]));
  if (problem) throw new Error(problem);
  return must(await db.from('players').insert(rows.map((r) => ({ team_id: team, ...r }))).select());
}

/** Fill missing and clashing jerseys (a clash keeps the first player's number) with the next free one. */
export function fillJerseys<T extends { team: string; jersey: string | null }>(roster: T[]): (T & { jersey: string })[] {
  for (const t of new Set(roster.map((r) => r.team))) {
    const used = new Set<string>();
    const needs: T[] = [];
    for (const r of roster.filter((x) => x.team === t)) {
      if (r.jersey && !used.has(r.jersey)) used.add(r.jersey);
      else needs.push(r);
    }
    let next = 0;
    for (const r of needs) {
      while (used.has(String(next))) next++;
      r.jersey = String(next);
      used.add(r.jersey);
    }
  }
  return roster as (T & { jersey: string })[];
}

export const ruleSets = async (league: string) => must(await db.from('rule_sets').select('id, name, rules').eq('league_id', league).order('name')) as RuleSetRow[];
/** Rule-set form labels by schema path, so a problem names the field to fix. */
const RULE_FIELDS: Record<string, string> = {
  name: 'Name', periods: 'Periods', periodLengthMs: 'Period length', overtimeLengthMs: 'Overtime length',
  personalFoulLimit: 'Personal fouls to foul out', 'teamFoulBonus.threshold': 'Team fouls before bonus',
  'teamFoulBonus.freeThrows': 'Bonus free throws', overtimeTimeouts: 'Overtime timeouts',
};

/** What's wrong with a rule set, in the form's words, or null. */
export function ruleSetProblem(rules: RuleSet): string | null {
  const parsed = v.safeParse(RuleSetSchema, rules);
  if (parsed.success) return null;
  return parsed.issues.map((i) => {
    const path = v.getDotPath(i);
    if (!path) return i.message;
    const label = RULE_FIELDS[path] ?? path;
    if (path === 'name') return 'Name is required';
    if (i.type === 'min_value') return path.endsWith('Ms') ? `${label} must be more than 0 minutes` : `${label} must be at least ${String(i.requirement)}`;
    if (i.type === 'integer') return `${label} must be a whole number`;
    return `${label}: ${i.message}`;
  }).join('; ');
}

export async function saveRuleSet(league: string, rules: RuleSet, id?: string) {
  const problem = ruleSetProblem(rules);
  if (problem) throw new Error(problem);
  const parsed = v.parse(RuleSetSchema, rules);
  const row = { league_id: league, name: rules.name, rules: parsed };
  return must(id ? await db.from('rule_sets').update(row).eq('id', id).select().single() : await db.from('rule_sets').insert(row).select().single());
}
export { FIBA };
export const deleteRuleSet = (id: string) => remove('rule_sets', id, 'Games use this rule set, so it stays.');
/** Only a game nobody has scored can be deleted; played games are locked instead. */
export const deleteGame = (id: string) => remove('games', id, 'This game has plays recorded. Lock it instead.');

export const games = async (league: string) =>
  must(await db.from('games').select('id, team_a, team_b, season_id, rule_set_id, mode, shot_locations, public_slug, scheduled_at, locked_at').eq('league_id', league).order('created_at', { ascending: false })) as GameRow[];

/** Create a game and pre-fill its roster from both teams' players (default jersey, else the next free number). */
export async function createGame(league: string, g: { team_a: string; team_b: string; season_id: string | null; rule_set_id: string; mode: 'single' | 'multi'; shot_locations: boolean; scheduled_at: string | null }) {
  if (g.team_a === g.team_b) throw new Error('Pick two different teams.');
  const game = must(await db.from('games').insert({ league_id: league, ...g }).select('id').single()) as { id: string };
  const roster = fillJerseys((await players([g.team_a, g.team_b])).map((p) => ({ game_id: game.id, player_id: p.id, team: p.team_id === g.team_a ? 'A' : 'B', jersey: p.default_jersey })));
  if (roster.length) must(await db.from('game_roster').insert(roster).select());
  return game.id;
}

export const gameRoster = async (game: string) => must(await db.from('game_roster').select('player_id, team, jersey').eq('game_id', game)) as RosterRow[];
export async function setJersey(game: string, player: string, jersey: string) {
  if (!/^\d{1,2}$/.test(jersey)) throw new Error('A jersey is 0-99 or 00.');
  const roster = await gameRoster(game);
  const team = roster.find((r) => r.player_id === player)?.team;
  if (roster.some((r) => r.team === team && r.player_id !== player && r.jersey === jersey)) throw new Error(`#${jersey} is already taken on this team.`);
  return must(await db.from('game_roster').update({ jersey }).eq('game_id', game).eq('player_id', player).select());
}

export interface CodeRow { code: string; expires_at: string; revoked_at: string | null }
export const codes = async (game: string) => must(await db.from('game_codes').select('code, expires_at, revoked_at').eq('game_id', game).order('created_at', { ascending: false })) as CodeRow[];
export const createCode = async (game: string) => must(await db.rpc('create_game_code', { game })) as string;
export const revokeCode = async (code: string) => must(await db.rpc('revoke_game_code', { revoked: code }));

/** A game's durable events (all pages), validated, and the effective log built from them. */
export async function gameLog(game: string): Promise<GameLog> {
  const log = new GameLog();
  for (let after = 0; ; ) {
    const page = must(await db.rpc('game_events', { game, after_seq: after })) as unknown[];
    for (const raw of page) {
      const r = parseEvent(raw);
      if (r.success) log.add(r.output);
    }
    if (page.length < 1000) return log;
    after = (page[page.length - 1] as GameEvent).seq!;
  }
}

/** Write an event as the admin (corrections and the lock). Admins write online only. */
export async function adminWrite(log: GameLog, game: string, body: EventBody) {
  const last = log.events[log.events.length - 1];
  const event = {
    id: crypto.randomUUID(),
    gameId: game,
    seq: null,
    deviceId: `admin-${user.value?.id ?? 'unknown'}`,
    deviceSeq: Date.now() % 2_000_000_000,
    role: 'admin',
    period: last?.period ?? 0,
    gameClock: 0,
    wallClock: Date.now(),
    ...body,
  };
  must(await db.rpc('insert_event', { event }));
}

export interface LatencyRow { device_id: string; kind: 'render' | 'peer'; ms: number }
export const latency = async (game: string) => must(await db.from('latency_samples').select('device_id, kind, ms').eq('game_id', game).limit(20_000)) as LatencyRow[];

/** Save text as a file in the browser. */
export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Apply a CSV import plan: create the new teams, then add every "add" row as a player. */
export async function importRoster(league: string, plan: import('./csv').ImportPlan): Promise<number> {
  const key = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const ids = new Map<string, string>();
  for (const name of plan.newTeams) ids.set(key(name), (await addTeam(league, name)).id);
  const byTeam = new Map<string, { name: string; default_jersey: string | null }[]>();
  for (const r of plan.rows) {
    if (r.status !== 'add') continue;
    const id = r.teamId ?? ids.get(key(r.team))!;
    byTeam.set(id, [...(byTeam.get(id) ?? []), { name: r.name, default_jersey: r.jersey }]);
  }
  for (const [team, rows] of byTeam) await addPlayers(team, rows);
  return [...byTeam.values()].reduce((n, rows) => n + rows.length, 0);
}

export const setPhoto = async (player: string, photo: string | null) => must(await db.from('players').update({ photo }).eq('id', player).select('id'));
