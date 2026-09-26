-- Durable events fan out over Realtime Broadcast. Two private channels per game:
--   game:<id>    scorers + admins. Read (durable confirmations) and send (client fast path).
--   view:<slug>  public viewers. Read only, so nobody can inject fake events for viewers.
-- ponytail: viewer updates are not batched. Batch if viewer counts make it matter.

create function public.broadcast_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  body jsonb := public.event_json(new);
begin
  perform realtime.send(body, 'event', 'game:' || new.game_id, true);
  perform realtime.send(body, 'event', 'view:' || (select g.public_slug from public.games g where g.id = new.game_id), true);
  return null;
end $$;

create trigger events_broadcast after insert on public.events
  for each row execute function public.broadcast_event();

create function public.can_use_game_topic(topic text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.games g
    where 'game:' || g.id = topic and (public.is_game_scorer(g.id) or public.is_league_admin(g.league_id))
  )
$$;

create function public.is_view_topic(topic text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.games g where 'view:' || g.public_slug = topic)
$$;

create policy "members receive game broadcasts" on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and public.can_use_game_topic(realtime.topic()));
create policy "members send game broadcasts" on realtime.messages for insert to authenticated
  with check (realtime.messages.extension = 'broadcast' and public.can_use_game_topic(realtime.topic()));
create policy "anyone with the slug receives viewer broadcasts" on realtime.messages for select to anon, authenticated
  using (realtime.messages.extension = 'broadcast' and public.is_view_topic(realtime.topic()));

-- Public read access by unguessable slug. Viewers get no table access at all.
create function public.public_game(slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'gameId', g.id,
    'teams', jsonb_build_object('A', ta.name, 'B', tb.name),
    'rules', rs.rules,
    'shotLocations', g.shot_locations,
    'locked', g.locked_at is not null,
    'roster', coalesce((
      select jsonb_agg(jsonb_build_object('playerId', p.id, 'name', p.name, 'jersey', r.jersey, 'team', r.team) order by r.team, r.jersey)
      from public.game_roster r join public.players p on p.id = r.player_id where r.game_id = g.id
    ), '[]'))
  from public.games g
  join public.teams ta on ta.id = g.team_a
  join public.teams tb on tb.id = g.team_b
  join public.rule_sets rs on rs.id = g.rule_set_id
  where g.public_slug = slug
$$;

create function public.public_events(slug text, after_seq bigint default 0) returns setof jsonb
language sql stable security definer set search_path = '' as $$
  select public.event_json(e) from public.events e join public.games g on g.id = e.game_id
  where g.public_slug = slug and e.seq > after_seq order by e.seq
$$;

grant execute on function public.public_game(text), public.public_events(text, bigint) to anon, authenticated;
