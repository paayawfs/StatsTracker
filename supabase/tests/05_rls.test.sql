begin;
select plan(21);

select tests.game_fixture('single') as f \gset
select (:'f'::jsonb ->> 'game')::uuid as game, (:'f'::jsonb ->> 'admin')::uuid as admin,
       (:'f'::jsonb ->> 'league')::uuid as league, (:'f'::jsonb ->> 'team_a')::uuid as team_a \gset
select tests.game_fixture('single') as f2 \gset
select (:'f2'::jsonb ->> 'game')::uuid as other_game \gset
select tests.create_user(true) as scorer \gset
select tests.create_user(true) as outsider \gset
select tests.create_user(false) as account \gset
insert into public.game_scorers (game_id, user_id, device_id) values (:'game', :'scorer', 'dev-1');
insert into public.role_claims values (:'game', 'single', :'scorer');
select tests.login(:'scorer');
select public.insert_event(tests.event(:'game', 'clockStart', 'single'));

-- Admin sees and manages their league only.
select tests.login(:'admin');
select is((select count(*)::int from public.games), 1, 'admin sees only their league''s game');
select lives_ok(format($$ insert into public.seasons (league_id, name) values (%L, '2026') $$, :'league'), 'admin creates a season');
select lives_ok(format($$ update public.teams set name = 'Renamed' where id = %L $$, :'team_a'), 'admin renames a team');
select is((select count(*)::int from public.events), 1, 'admin reads their game''s events');
select is((select count(*)::int from public.game_codes), 0, 'admin can read codes (none yet)');

-- Scorer reads their game, roster, names and events; writes nothing directly.
select tests.login(:'scorer');
select is((select count(*)::int from public.games), 1, 'scorer sees their game only');
select is((select count(*)::int from public.game_roster), 16, 'scorer sees the roster');
select is((select count(*)::int from public.rule_sets), 1, 'scorer sees their rule set');
select is((select count(*)::int from public.players), 16, 'scorer sees player names');
select is((select count(*)::int from public.teams), 2, 'scorer sees both team names');
select is((select count(*)::int from public.events), 1, 'scorer reads events');
select is((select count(*)::int from public.game_events(:'game', 0)), 1, 'game_events returns catch-up events');
select is((select public.game_events(:'game', 0) ->> 'type'), 'clockStart', 'game_events returns core-shaped JSON');
select throws_ok(
  format($$ insert into public.events (id, game_id, seq, device_id, device_seq, role, period, game_clock, wall_clock, type, payload)
            values (gen_random_uuid(), %L, 99, 'd', 0, 'single', 1, 0, 0, 'clockStop', '{}') $$, :'game'),
  '42501', null, 'scorer cannot insert events directly');
select is((select count(*)::int from public.game_codes), 0, 'scorer cannot read codes');
update public.games set mode = 'multi';
select tests.as_postgres();
select is((select mode from public.games where id = :'game'), 'single', 'scorer cannot update the game');

-- Outsiders see nothing.
select tests.login(:'outsider');
select is((select count(*)::int from public.events) + (select count(*)::int from public.games) + (select count(*)::int from public.players), 0, 'outsider sees nothing');

-- Anonymous (no sign-in) sees nothing.
select tests.as_anon();
select is((select count(*)::int from public.events) + (select count(*)::int from public.games) + (select count(*)::int from public.game_codes), 0, 'anon sees no rows');

-- Leagues: accounts can create, anonymous scorers cannot.
select tests.login(:'account');
select isnt(public.create_league('New League'), null, 'an account creates a league');
select is((select count(*)::int from public.leagues), 1, 'and administers it');
select tests.login(:'scorer');
select throws_ok($$ select public.create_league('Nope') $$, '42501', null, 'anonymous scorers cannot create leagues');

select * from finish();
rollback;
