import { signal } from '@preact/signals';
import { FIBA, GameLog, parseEvent, RuleSetSchema, type EventBody, type GameEvent, type RuleSet, type Team } from '@stats/core';
import { createClient, type User } from '@supabase/supabase-js';
import * as v from 'valibot';

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
export const addSeason = async (league: string, name: string) => must(await db.from('seasons').insert({ league_id: league, name }).select().single());

export const teams = async (league: string) => must(await db.from('teams').select('id, name').eq('league_id', league).order('name')) as TeamRow[];
export const addTeam = async (league: string, name: string) => must(await db.from('teams').insert({ league_id: league, name }).select('id, name').single()) as TeamRow;
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
      return m ? { name: m[2]!.trim(), default_jersey: m[1]! } : { name: l, default_jersey: null };
    });
}
export const addPlayers = async (team: string, rows: { name: string; default_jersey: string | null }[]) =>
  must(await db.from('players').insert(rows.map((r) => ({ team_id: team, ...r }))).select());

export const ruleSets = async (league: string) => must(await db.from('rule_sets').select('id, name, rules').eq('league_id', league).order('name')) as RuleSetRow[];
export async function saveRuleSet(league: string, rules: RuleSet, id?: string) {
  const parsed = v.safeParse(RuleSetSchema, rules);
  if (!parsed.success) throw new Error(parsed.issues.map((i) => i.message).join('; '));
  const row = { league_id: league, name: rules.name, rules: parsed.output };
  return must(id ? await db.from('rule_sets').update(row).eq('id', id).select().single() : await db.from('rule_sets').insert(row).select().single());
}
export { FIBA };

export const games = async (league: string) =>
  must(await db.from('games').select('id, team_a, team_b, season_id, rule_set_id, mode, shot_locations, public_slug, scheduled_at, locked_at').eq('league_id', league).order('created_at', { ascending: false })) as GameRow[];

/** Create a game and pre-fill its roster from both teams' players (default jersey, else the next free number). */
export async function createGame(league: string, g: { team_a: string; team_b: string; season_id: string | null; rule_set_id: string; mode: 'single' | 'multi'; shot_locations: boolean; scheduled_at: string | null }) {
  if (g.team_a === g.team_b) throw new Error('Pick two different teams.');
  const game = must(await db.from('games').insert({ league_id: league, ...g }).select('id').single()) as { id: string };
  const roster = (await players([g.team_a, g.team_b])).map((p) => ({ game_id: game.id, player_id: p.id, team: p.team_id === g.team_a ? 'A' : 'B', jersey: p.default_jersey }));
  for (const t of ['A', 'B']) {
    const used = new Set(roster.filter((r) => r.team === t && r.jersey).map((r) => r.jersey));
    let next = 0;
    for (const r of roster.filter((x) => x.team === t && !x.jersey)) {
      while (used.has(String(next))) next++;
      r.jersey = String(next);
      used.add(r.jersey);
    }
  }
  if (roster.length) must(await db.from('game_roster').insert(roster).select());
  return game.id;
}

export const gameRoster = async (game: string) => must(await db.from('game_roster').select('player_id, team, jersey').eq('game_id', game)) as RosterRow[];
export const setJersey = async (game: string, player: string, jersey: string) => must(await db.from('game_roster').update({ jersey }).eq('game_id', game).eq('player_id', player).select());

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
