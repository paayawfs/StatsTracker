-- Phase 7: admin support.

-- A player's usual jersey, used to pre-fill game rosters (the roster keeps its own per-game copy).
alter table public.players add column default_jersey text;

-- Add a co-admin by the email of an existing account. Returns false if no account has that email.
create function public.add_league_admin(league uuid, admin_email text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  if not public.is_league_admin(league) then
    raise exception 'only league admins can add admins' using errcode = '42501';
  end if;
  select u.id into target from auth.users u where lower(u.email) = lower(trim(admin_email)) and not coalesce(u.is_anonymous, false);
  if target is null then
    return false;
  end if;
  insert into public.league_admins (league_id, user_id) values (league, target) on conflict do nothing;
  return true;
end $$;
revoke execute on function public.add_league_admin(uuid, text) from public, anon;
grant execute on function public.add_league_admin(uuid, text) to authenticated;

-- Latency instrumentation (brief section 4): scorer devices upload tap-to-render and
-- tap-to-peer-receipt samples per game; admins read them.
create table public.latency_samples (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games on delete cascade,
  device_id text not null,
  kind text not null check (kind in ('render', 'peer')),
  ms real not null check (ms >= 0),
  recorded_at timestamptz not null default now()
);
create index latency_samples_game on public.latency_samples (game_id, kind);
alter table public.latency_samples enable row level security;
create policy "admins read latency" on public.latency_samples for select to authenticated
  using (public.is_league_admin((select g.league_id from public.games g where g.id = game_id)));

create function public.record_latency(game uuid, device text, samples jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_game_scorer(game) then
    raise exception 'not a scorer of this game' using errcode = '42501';
  end if;
  if jsonb_typeof(samples) <> 'array' or jsonb_array_length(samples) > 500 then
    raise exception 'samples must be an array of at most 500' using errcode = '22023';
  end if;
  insert into public.latency_samples (game_id, device_id, kind, ms)
  select game, device, s ->> 'kind', (s ->> 'ms')::real from jsonb_array_elements(samples) s;
end $$;
revoke execute on function public.record_latency(uuid, text, jsonb) from public, anon;
grant execute on function public.record_latency(uuid, text, jsonb) to authenticated;
