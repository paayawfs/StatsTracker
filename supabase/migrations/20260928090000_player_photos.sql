-- Small player photos (about 96x96 WebP, 5-8 KB) stored inline, so game info stays one small
-- request and photos work offline on scoring devices. Capped at ~30 KB.
-- ponytail: inline data URLs; move to Supabase Storage if full-size photos are ever needed.
alter table public.players add column photo text
  check (photo is null or (photo like 'data:image/%' and length(photo) <= 30000));

create or replace function public.public_game(slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'gameId', g.id,
    'teams', jsonb_build_object('A', ta.name, 'B', tb.name),
    'rules', rs.rules,
    'shotLocations', g.shot_locations,
    'locked', g.locked_at is not null,
    'roster', coalesce((
      select jsonb_agg(jsonb_build_object('playerId', p.id, 'name', p.name, 'jersey', r.jersey, 'team', r.team, 'photo', p.photo) order by r.team, r.jersey)
      from public.game_roster r join public.players p on p.id = r.player_id where r.game_id = g.id
    ), '[]'))
  from public.games g
  join public.teams ta on ta.id = g.team_a
  join public.teams tb on tb.id = g.team_b
  join public.rule_sets rs on rs.id = g.rule_set_id
  where g.public_slug = slug
$$;
