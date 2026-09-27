// Creates a demo league, two teams of 12, a game and a join code. Stand-in for the Phase 7
// admin screens. Usage: pnpm dev:game [--multi]
// Local by default (the CLI's fixed demo keys). For hosted, set SUPABASE_URL, SUPABASE_ANON_KEY
// and SUPABASE_SERVICE_KEY.
import { createClient } from '@supabase/supabase-js';
import { FIBA } from '../packages/core/src/rules';

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON = process.env.SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE = process.env.SUPABASE_SERVICE_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const mode = process.argv.includes('--multi') ? 'multi' : 'single';
const opts = { auth: { persistSession: false } };

const must = <T>(r: { data: T | null; error: unknown }): T => {
  if (r.error) throw r.error;
  return r.data as T;
};

const email = 'dev-admin@stats.local';
const password = 'dev-admin-password';
const service = createClient(URL, SERVICE, opts);
await service.auth.admin.createUser({ email, password, email_confirm: true }); // fails harmlessly if it exists
const admin = createClient(URL, ANON, opts);
must(await admin.auth.signInWithPassword({ email, password }));

const league = must(await admin.rpc('create_league', { league_name: 'Demo League' })) as string;
const rs = must(await admin.from('rule_sets').insert({ league_id: league, name: 'FIBA', rules: FIBA }).select('id').single()) as { id: string };
const teams = must(await admin.from('teams').insert([{ league_id: league, name: 'Accra Lions' }, { league_id: league, name: 'Tema Tigers' }]).select('id, name')) as { id: string; name: string }[];

const first = ['Kwame', 'Kofi', 'Yaw', 'Kojo', 'Kwesi', 'Kwaku', 'Ama', 'Akosua', 'Efua', 'Abena', 'Esi', 'Adwoa'];
const last = [['Asante', 'Mensah', 'Boateng', 'Owusu', 'Darko', 'Appiah', 'Ofori', 'Nti', 'Addo', 'Kyei', 'Quaye', 'Tetteh'], ['Amoah', 'Bonsu', 'Frimpong', 'Agyeman', 'Sarpong', 'Acheampong', 'Opoku', 'Antwi', 'Osei', 'Danquah', 'Lartey', 'Annan']];
const game = must(await admin.from('games').insert({ league_id: league, team_a: teams[0]!.id, team_b: teams[1]!.id, rule_set_id: rs.id, mode, shot_locations: true }).select('id, public_slug').single()) as { id: string; public_slug: string };
for (const [t, team] of teams.entries()) {
  const players = must(await admin.from('players').insert(first.map((f, i) => ({ team_id: team.id, name: `${f} ${last[t]![i]}`, default_jersey: String(i + 4) }))).select('id')) as { id: string }[];
  must(await admin.from('game_roster').insert(players.map((p, i) => ({ game_id: game.id, player_id: p.id, team: t ? 'B' : 'A', jersey: String([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15][i]) }))).select());
}
const code = must(await admin.rpc('create_game_code', { game: game.id })) as string;

console.log(`\n${mode} game ready\n  code:   ${code}\n  game:   ${game.id}\n  public: ${game.public_slug}\n`);
