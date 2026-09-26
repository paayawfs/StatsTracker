-- Local only (runs on `supabase start` / `db reset`, never on hosted projects).
-- Test helpers for pgTAP files in supabase/tests.

create schema if not exists tests;
grant usage on schema tests to anon, authenticated;

create or replace function tests.create_user(anonymous boolean default false) returns uuid
language plpgsql as $$
declare uid uuid := gen_random_uuid();
begin
  insert into auth.users (id, aud, role, email, is_anonymous)
  values (uid, 'authenticated', 'authenticated', case when anonymous then null else uid || '@test.local' end, anonymous);
  return uid;
end $$;

-- Readable from any role (login may be called while already acting as a user).
create or replace function tests.is_anonymous(uid uuid) returns boolean
language sql security definer as $$ select is_anonymous from auth.users where id = uid $$;

-- Act as a signed-in user for the rest of the transaction.
create or replace function tests.login(uid uuid) returns void
language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object(
    'sub', uid, 'role', 'authenticated', 'is_anonymous', tests.is_anonymous(uid)
  )::text, true);
end $$;

create or replace function tests.as_anon() returns void
language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
end $$;

create or replace function tests.as_postgres() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- A league with an admin, two teams of 8 players, a FIBA rule set and a game.
-- Returns ids as jsonb: admin, league, game, team_a, team_b, slug, a[1..8], b[1..8] (player ids).
create or replace function tests.game_fixture(game_mode text default 'multi') returns jsonb
language plpgsql as $$
declare
  admin uuid := tests.create_user();
  league uuid;
  ta uuid;
  tb uuid;
  rs uuid;
  g uuid;
  slug text;
  a uuid[];
  b uuid[];
begin
  insert into public.leagues (name) values ('Test League') returning id into league;
  insert into public.league_admins values (league, admin);
  insert into public.teams (league_id, name) values (league, 'Team A') returning id into ta;
  insert into public.teams (league_id, name) values (league, 'Team B') returning id into tb;
  insert into public.rule_sets (league_id, name, rules) values (league, 'FIBA', '{}') returning id into rs;
  with p as (insert into public.players (team_id, name) select ta, 'A' || i from generate_series(1, 8) i returning id)
    select array_agg(id) into a from p;
  with p as (insert into public.players (team_id, name) select tb, 'B' || i from generate_series(1, 8) i returning id)
    select array_agg(id) into b from p;
  insert into public.games (league_id, team_a, team_b, rule_set_id, mode)
    values (league, ta, tb, rs, game_mode) returning id, public_slug into g, slug;
  insert into public.game_roster select g, id, 'A', '4' from unnest(a) id;
  insert into public.game_roster select g, id, 'B', '4' from unnest(b) id;
  return jsonb_build_object('admin', admin, 'league', league, 'game', g, 'team_a', ta, 'team_b', tb,
    'slug', slug, 'a', to_jsonb(a), 'b', to_jsonb(b));
end $$;

-- A core-shaped event for insert_event(). Payload defaults to {}.
create or replace function tests.event(game uuid, type text, role text, payload jsonb default '{}', id uuid default gen_random_uuid())
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', id, 'gameId', game, 'seq', null, 'deviceId', 'dev', 'deviceSeq', 0, 'role', role,
    'period', 1, 'gameClock', 600000, 'wallClock', 1, 'type', type, 'payload', payload)
$$;

grant execute on all functions in schema tests to anon, authenticated;
