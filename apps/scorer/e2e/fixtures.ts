import { expect, type Browser, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { FIBA } from '../../../packages/core/src/rules';

const URL = 'http://127.0.0.1:54321';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const opts = { auth: { persistSession: false } };

const must = <T>(r: { data: T | null; error: unknown }): T => {
  if (r.error) throw r.error;
  return r.data as T;
};

/** A fresh game (jerseys 4..15 per team) and its join code. */
export async function createGame(shotLocations = false, mode: 'single' | 'multi' = 'single') {
  const service = createClient(URL, SERVICE, opts);
  const email = `e2e-${crypto.randomUUID()}@test.local`;
  const password = 'e2e-password-123';
  must(await service.auth.admin.createUser({ email, password, email_confirm: true }));
  const admin = createClient(URL, ANON, opts);
  must(await admin.auth.signInWithPassword({ email, password }));
  const league = must(await admin.rpc('create_league', { league_name: 'E2E' })) as string;
  const rs = must(await admin.from('rule_sets').insert({ league_id: league, name: 'FIBA', rules: FIBA }).select('id').single()) as { id: string };
  const teams = must(await admin.from('teams').insert([{ league_id: league, name: 'Lions' }, { league_id: league, name: 'Tigers' }]).select('id')) as { id: string }[];
  const game = must(
    await admin.from('games').insert({ league_id: league, team_a: teams[0]!.id, team_b: teams[1]!.id, rule_set_id: rs.id, mode, shot_locations: shotLocations }).select('id, public_slug').single(),
  ) as { id: string; public_slug: string };
  for (const [i, t] of teams.entries()) {
    const players = must(await admin.from('players').insert(Array.from({ length: 12 }, (_, j) => ({ team_id: t.id, name: `${i ? 'Tiger' : 'Lion'} ${j + 4}` }))).select('id')) as { id: string }[];
    must(await admin.from('game_roster').insert(players.map((p, j) => ({ game_id: game.id, player_id: p.id, team: i ? 'B' : 'A', jersey: String(j + 4) }))).select());
  }
  const code = must(await admin.rpc('create_game_code', { game: game.id })) as string;
  return { code, gameId: game.id, slug: game.public_slug };
}

/** Durable events the public sees for a game. */
export async function serverEvents(slug: string) {
  const viewer = createClient(URL, ANON, opts);
  return must(await viewer.rpc('public_events', { slug, after_seq: 0 })) as { type: string; payload: Record<string, unknown> }[];
}

async function joinCode(page: Page, code: string) {
  await page.goto('/');
  await page.getByLabel('Game code').fill(code);
  await page.getByRole('button', { name: 'Join game' }).click();
}

/** Pick jerseys 4-8 as starters for both teams and start the game (game-control device). */
export async function pickStartersAndStart(page: Page) {
  for (const t of ['A', 'B']) for (const j of [4, 5, 6, 7, 8]) await page.getByTestId(`starter-${j}-${t}`).click();
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page.getByTestId('clock')).toHaveText('10:00');
}

/** Single mode: join, pick starters, start. */
export async function joinAndStart(page: Page, code: string) {
  await joinCode(page, code);
  await pickStartersAndStart(page);
}

/** Multi mode: a separate device (own storage and session) that joins and claims a role. */
export async function device(browser: Browser, code: string, role: 'teamA' | 'teamB' | 'clock') {
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const page = await context.newPage();
  await joinCode(page, code);
  await page.getByTestId(`role-${role}`).getByRole('button', { name: 'Claim' }).click();
  await expect(page.getByRole('heading', { name: 'Pick your role' })).toHaveCount(0); // role held
  return { context, page };
}

export const player = (page: Page, team: 'A' | 'B', jersey: number) => page.getByTestId(`player-${team}-${jersey}`);
export const btn = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

/** Open the ☰ menu and pick an item (Play-by-play, End period, Roles, ...). */
export async function menu(page: Page, item: string) {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: item, exact: true }).click();
}
