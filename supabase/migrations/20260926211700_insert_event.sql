-- The durable write path. Clients never insert into events directly.

create function public.is_league_admin(league uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.league_admins where league_id = league and user_id = auth.uid())
$$;

create function public.is_game_scorer(game uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.game_scorers where game_id = game and user_id = auth.uid())
$$;

-- An events row in the packages/core GameEvent JSON shape.
create function public.event_json(e public.events) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', e.id, 'gameId', e.game_id, 'seq', e.seq, 'deviceId', e.device_id, 'deviceSeq', e.device_seq,
    'role', e.role, 'period', e.period, 'gameClock', e.game_clock, 'wallClock', e.wall_clock,
    'type', e.type, 'payload', e.payload)
$$;

-- Hook for role authority (next migration). Here: any member may write.
create function public.authorize_event(g public.games, event jsonb) returns void
language plpgsql set search_path = '' as $$ begin end $$;

/**
 * Validate, authorize, and append one event. Returns its canonical seq.
 * Resending an event (same id) returns the seq it already has, so outbox retries are safe.
 * Game rules are NOT checked here: packages/core flags them (they can't be judged per event
 * when offline devices merge).
 */
create function public.insert_event(event jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  g public.games;
  existing public.events;
  next_seq bigint;
begin
  if not extensions.jsonb_matches_schema(public.event_json_schema(), event) then
    raise exception 'event does not match schema' using errcode = '22023';
  end if;

  -- Row lock serialises seq assignment per game; other games are unaffected.
  select * into g from public.games where id = (event ->> 'gameId')::uuid for update;
  if not found or not (public.is_game_scorer(g.id) or public.is_league_admin(g.league_id)) then
    raise exception 'not a scorer or admin of this game' using errcode = '42501';
  end if;

  select * into existing from public.events where id = (event ->> 'id')::uuid;
  if found then
    if existing.game_id <> g.id then
      raise exception 'event id already used in another game' using errcode = '23505';
    end if;
    return existing.seq;
  end if;

  perform public.authorize_event(g, event);

  update public.games set last_seq = last_seq + 1 where id = g.id returning last_seq into next_seq;

  insert into public.events (id, game_id, seq, device_id, device_seq, role, period, game_clock, wall_clock, type, payload, inserted_by)
  values (
    (event ->> 'id')::uuid, g.id, next_seq, event ->> 'deviceId', (event ->> 'deviceSeq')::int, event ->> 'role',
    (event ->> 'period')::int, (event ->> 'gameClock')::int, (event ->> 'wallClock')::bigint,
    event ->> 'type', event -> 'payload', auth.uid()
  );
  return next_seq;
end $$;

revoke execute on function public.insert_event(jsonb) from public, anon;
grant execute on function public.insert_event(jsonb) to authenticated;
revoke execute on function public.authorize_event(public.games, jsonb) from public, anon, authenticated;
