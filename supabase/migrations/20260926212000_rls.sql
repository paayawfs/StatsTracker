-- Row level security. Writes to events, codes, scorers and roles go only through functions.

-- Real (non-anonymous) accounts. Anonymous scorers are also role `authenticated`.
create function public.is_account() returns boolean
language sql stable set search_path = '' as $$
  select auth.uid() is not null and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
$$;

-- Any account (not an anonymous scorer) can create a league and becomes its admin.
create function public.create_league(league_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare league uuid;
begin
  if not public.is_account() then
    raise exception 'sign in with an account to create a league' using errcode = '42501';
  end if;
  insert into public.leagues (name) values (league_name) returning id into league;
  insert into public.league_admins (league_id, user_id) values (league, auth.uid());
  return league;
end $$;
revoke execute on function public.create_league(text) from public, anon;
grant execute on function public.create_league(text) to authenticated;

create policy "admins manage leagues" on public.leagues for all to authenticated
  using (public.is_league_admin(id)) with check (public.is_league_admin(id));

create policy "admins manage admins" on public.league_admins for all to authenticated
  using (public.is_league_admin(league_id)) with check (public.is_league_admin(league_id));

create policy "admins manage rule sets" on public.rule_sets for all to authenticated
  using (public.is_league_admin(league_id)) with check (public.is_league_admin(league_id));
create policy "admins manage seasons" on public.seasons for all to authenticated
  using (public.is_league_admin(league_id)) with check (public.is_league_admin(league_id));
create policy "admins manage teams" on public.teams for all to authenticated
  using (public.is_league_admin(league_id)) with check (public.is_league_admin(league_id));
create policy "admins manage players" on public.players for all to authenticated
  using (public.is_league_admin((select t.league_id from public.teams t where t.id = team_id)))
  with check (public.is_league_admin((select t.league_id from public.teams t where t.id = team_id)));

create policy "admins manage games" on public.games for all to authenticated
  using (public.is_league_admin(league_id)) with check (public.is_league_admin(league_id));
create policy "scorers read their game" on public.games for select to authenticated
  using (public.is_game_scorer(id));

create policy "admins manage rosters" on public.game_roster for all to authenticated
  using (public.is_league_admin((select g.league_id from public.games g where g.id = game_id)))
  with check (public.is_league_admin((select g.league_id from public.games g where g.id = game_id)));
create policy "scorers read their roster" on public.game_roster for select to authenticated
  using (public.is_game_scorer(game_id));

-- Scorers need team and player names for their game.
create policy "scorers read their teams" on public.teams for select to authenticated
  using (exists (select 1 from public.games g where (g.team_a = teams.id or g.team_b = teams.id) and public.is_game_scorer(g.id)));
create policy "scorers read their players" on public.players for select to authenticated
  using (exists (select 1 from public.game_roster r where r.player_id = players.id and public.is_game_scorer(r.game_id)));
create policy "scorers read their rule set" on public.rule_sets for select to authenticated
  using (exists (select 1 from public.games g where g.rule_set_id = rule_sets.id and public.is_game_scorer(g.id)));

create policy "admins read codes" on public.game_codes for select to authenticated
  using (public.is_league_admin((select g.league_id from public.games g where g.id = game_id)));

create policy "admins and self read scorers" on public.game_scorers for select to authenticated
  using (user_id = auth.uid() or public.is_league_admin((select g.league_id from public.games g where g.id = game_id)));

create policy "members read roles" on public.role_claims for select to authenticated
  using (public.is_game_scorer(game_id) or public.is_league_admin((select g.league_id from public.games g where g.id = game_id)));

create policy "members read events" on public.events for select to authenticated
  using (public.is_game_scorer(game_id) or public.is_league_admin((select g.league_id from public.games g where g.id = game_id)));

-- Reconnect catch-up for scorers and admins: events after a seq, in core JSON shape.
create function public.game_events(game uuid, after_seq bigint default 0) returns setof jsonb
language sql stable set search_path = '' as $$
  select public.event_json(e) from public.events e where e.game_id = game and e.seq > after_seq order by e.seq
$$;
revoke execute on function public.game_events(uuid, bigint) from public, anon;
grant execute on function public.game_events(uuid, bigint) to authenticated;
