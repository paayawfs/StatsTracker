/// <reference types="node" />
import 'fake-indexeddb/auto';
import { FIBA, type EventOf, type EventType, type GameEvent } from '@stats/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, test } from 'vitest';
import { GameSync } from './game-sync';
import { LocalStore } from './store';
import { SupabaseTransport, supabaseClientOptions } from './supabase';

// Runs against local Supabase (`pnpm exec supabase start`). These are the CLI's fixed local demo
// keys, not secrets. Override with env vars to point elsewhere.
const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON = process.env.SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE = process.env.SUPABASE_SERVICE_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const reachable = await fetch(`${URL}/auth/v1/health`, { headers: { apikey: ANON } }).then((r) => r.ok, () => false);
if (!reachable) console.warn(`SKIPPED: Supabase not reachable at ${URL}`);

const opts = { auth: { persistSession: false } };
const clients: SupabaseClient[] = [];
const syncs: GameSync[] = [];
afterAll(async () => {
  for (const s of syncs) s.close();
  for (const c of clients) await c.removeAllChannels();
});

async function until(cond: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setupGame() {
  const service = createClient(URL, SERVICE, opts);
  const email = `admin-${crypto.randomUUID()}@test.local`;
  const password = 'correct-horse-battery';
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const admin = createClient(URL, ANON, opts);
  clients.push(admin);
  await admin.auth.signInWithPassword({ email, password });
  const must = <T>(r: { data: T | null; error: unknown }): T => {
    if (r.error) throw r.error;
    return r.data!;
  };
  const league = must(await admin.rpc('create_league', { league_name: 'Integration' })) as string;
  const rs = (must(await admin.from('rule_sets').insert({ league_id: league, name: 'FIBA', rules: FIBA }).select('id').single()) as { id: string }).id;
  const [ta, tb] = must(await admin.from('teams').insert([{ league_id: league, name: 'A' }, { league_id: league, name: 'B' }]).select('id')).map((t) => t.id as string);
  const roster = async (team: string) =>
    must(await admin.from('players').insert(Array.from({ length: 8 }, (_, i) => ({ team_id: team, name: `P${i}` }))).select('id')).map((p) => p.id as string);
  const a = await roster(ta!);
  const b = await roster(tb!);
  const game: { id: string; public_slug: string } = must(await admin.from('games').insert({ league_id: league, team_a: ta, team_b: tb, rule_set_id: rs, mode: 'multi' }).select('id, public_slug').single());
  must(await admin.from('game_roster').insert([...a.map((p) => ({ game_id: game.id, player_id: p, team: 'A', jersey: '1' })), ...b.map((p) => ({ game_id: game.id, player_id: p, team: 'B', jersey: '1' }))]).select());
  const code = must(await admin.rpc('create_game_code', { game: game.id })) as string;
  return { game: game.id as string, slug: game.public_slug as string, code, a, b };
}

async function scorer(game: string, code: string, device: string) {
  const c = createClient(URL, ANON, { ...opts, ...supabaseClientOptions });
  clients.push(c);
  const signIn = await c.auth.signInAnonymously();
  if (signIn.error) throw signIn.error;
  const joined = await c.rpc('join_game', { join_code: code, device });
  if (joined.error) throw joined.error;
  await c.realtime.setAuth();
  const store = await LocalStore.open(`int-${device}-${crypto.randomUUID()}`);
  const sync = await GameSync.open({ gameId: game, deviceId: device, transport: new SupabaseTransport(c, game), store });
  syncs.push(sync);
  await until(() => sync.online);
  return sync;
}

let clock = 600_000;
function tap<T extends EventType>(sync: GameSync, role: GameEvent['role'], type: T, payload: EventOf<T>['payload'], env: Partial<GameEvent> = {}) {
  return {
    id: crypto.randomUUID(), gameId: sync.gameId, seq: null, deviceId: sync.deviceId, deviceSeq: sync.nextDeviceSeq(),
    role, period: 1, gameClock: (clock -= 100), wallClock: Math.round(sync.now()), ...env, type, payload,
  } as EventOf<T>;
}

const allConfirmed = (s: GameSync) => s.log.events.length > 0 && s.log.events.every((e) => e.seq !== null);

describe.skipIf(!reachable)('SupabaseTransport against local Supabase', () => {
  test('two scorers on separate devices converge; authority rejections are pulled back', async () => {
    const g = await setupGame();
    const A = await scorer(g.game, g.code, 'dev-A');
    const B = await scorer(g.game, g.code, 'dev-B');
    const latencies: number[] = [];
    B.onPeerLatency = (_, ms) => latencies.push(ms);

    A.record(tap(A, 'teamA', 'roleClaim', { role: 'teamA' }));
    B.record(tap(B, 'teamB', 'roleClaim', { role: 'teamB' }));
    await until(() => A.log.events.length === 2 && B.log.events.length === 2 && allConfirmed(A) && allConfirmed(B));

    A.record(tap(A, 'teamA', 'gameStart', {
      rules: FIBA, shotLocations: false,
      roster: { A: g.a.map((playerId) => ({ playerId, jersey: '1' })), B: g.b.map((playerId) => ({ playerId, jersey: '1' })) },
    }, { period: 0, gameClock: 0 }));
    A.record(tap(A, 'teamA', 'periodStart', { lineups: { A: g.a.slice(0, 5), B: g.b.slice(0, 5) } }, { gameClock: 600_000 }));
    A.record(tap(A, 'teamA', 'clockStart', {}));
    A.record(tap(A, 'teamA', 'shot', { shooter: g.a[0]!, value: 3, made: true }));
    B.record(tap(B, 'teamB', 'shot', { shooter: g.b[0]!, value: 2, made: false }));
    A.record(tap(A, 'teamA', 'rebound', { team: 'A', player: g.a[1]!, kind: 'defensive' }));

    // A writes an event team B owns: the server refuses it and B must drop its fast-path copy.
    const rejected: string[] = [];
    A.onRejected = (_, reason) => rejected.push(reason);
    const bad = tap(A, 'teamA', 'shot', { shooter: g.b[1]!, value: 2, made: true });
    A.record(bad);

    await until(() => rejected.length === 1 && A.log.events.length === 8 && B.log.events.length === 8 && allConfirmed(A) && allConfirmed(B));
    expect(A.log.events).toEqual(B.log.events);
    expect(A.log.state.score).toEqual({ A: 3, B: 0 });
    expect(B.log.get(bad.id)).toBeUndefined();
    expect(rejected[0]).toMatch(/belong to role teamB/);
    expect(A.rejected.map((r) => r.event.id)).toEqual([bad.id]);

    // A late joiner catches up from the server on connect.
    const C = await scorer(g.game, g.code, 'dev-C');
    await until(() => C.log.events.length === 8);
    expect(C.log.events).toEqual(A.log.events);

    // Public viewers read the same log by slug.
    const viewer = createClient(URL, ANON, opts);
    clients.push(viewer);
    const pub = await viewer.rpc('public_events', { slug: g.slug, after_seq: 0 });
    // public_events is in seq (arrival) order; the log is in canonical game order.
    const bySeq = [...A.log.events].sort((x, y) => x.seq! - y.seq!);
    expect((pub.data as GameEvent[]).map((e) => e.id)).toEqual(bySeq.map((e) => e.id));

    // Local stack: clocks agree and the fast path is well inside the 300 ms peer budget.
    expect(Math.abs(A.clockOffset)).toBeLessThan(1000);
    expect(latencies.length).toBeGreaterThan(0);
    console.warn(`peer fast-path latency (local): ${latencies.map((l) => Math.round(l)).join(', ')} ms`);
    expect(Math.max(...latencies)).toBeLessThan(300);
  }, 30_000);
});
