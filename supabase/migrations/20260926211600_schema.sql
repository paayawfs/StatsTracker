-- Core schema. Game state is never stored: it is derived from `events` by packages/core.

create extension if not exists pg_jsonschema with schema extensions;

create table public.leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.league_admins (
  league_id uuid not null references public.leagues on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  primary key (league_id, user_id)
);

-- `rules` is a packages/core RuleSet, validated by the admin app.
create table public.rule_sets (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues on delete cascade,
  name text not null,
  rules jsonb not null
);

create table public.seasons (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues on delete cascade,
  name text not null
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues on delete cascade,
  name text not null
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams on delete cascade,
  name text not null
);

create table public.games (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues,
  season_id uuid references public.seasons,
  team_a uuid not null references public.teams,
  team_b uuid not null references public.teams,
  rule_set_id uuid not null references public.rule_sets,
  mode text not null check (mode in ('single', 'multi')),
  shot_locations boolean not null default false,
  -- Unguessable link for public viewers (122 random bits).
  public_slug text not null unique default replace(gen_random_uuid()::text, '-', ''),
  scheduled_at timestamptz,
  -- Last assigned event seq. Incremented under a row lock by insert_event.
  last_seq bigint not null default 0,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  check (team_a <> team_b)
);

create table public.game_roster (
  game_id uuid not null references public.games on delete cascade,
  player_id uuid not null references public.players,
  team text not null check (team in ('A', 'B')),
  jersey text not null,
  primary key (game_id, player_id)
);

create table public.game_codes (
  code text primary key,
  game_id uuid not null references public.games on delete cascade,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- Anonymous scorers who joined a game with a code. One row per user (= device session).
create table public.game_scorers (
  game_id uuid not null references public.games on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  device_id text not null,
  code text references public.game_codes on delete set null,
  joined_at timestamptz not null default now(),
  primary key (game_id, user_id),
  unique (game_id, device_id)
);

-- Who holds each role right now. The primary key makes roles exclusive.
create table public.role_claims (
  game_id uuid not null references public.games on delete cascade,
  role text not null check (role in ('single', 'teamA', 'teamB', 'clock')),
  user_id uuid not null references auth.users on delete cascade,
  claimed_at timestamptz not null default now(),
  primary key (game_id, role)
);

-- The event log: the only source of truth. Append-only, written only via insert_event().
create table public.events (
  id uuid primary key,
  game_id uuid not null references public.games,
  seq bigint not null,
  device_id text not null,
  device_seq integer not null,
  role text not null,
  period integer not null,
  game_clock integer not null,
  wall_clock bigint not null,
  type text not null,
  payload jsonb not null,
  inserted_by uuid,
  inserted_at timestamptz not null default now(),
  unique (game_id, seq)
);

create function public.events_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'events are append-only: corrections are new events' using errcode = '42501';
end $$;

create trigger events_no_update_delete before update or delete on public.events
  for each row execute function public.events_append_only();
create trigger events_no_truncate before truncate on public.events
  for each statement execute function public.events_append_only();

-- Every table is locked down until step-specific policies open it.
alter table public.leagues enable row level security;
alter table public.league_admins enable row level security;
alter table public.rule_sets enable row level security;
alter table public.seasons enable row level security;
alter table public.teams enable row level security;
alter table public.players enable row level security;
alter table public.games enable row level security;
alter table public.game_roster enable row level security;
alter table public.game_codes enable row level security;
alter table public.game_scorers enable row level security;
alter table public.role_claims enable row level security;
alter table public.events enable row level security;
