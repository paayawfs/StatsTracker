begin;
select plan(12);

select tests.game_fixture('single') as f \gset
select (:'f'::jsonb ->> 'game')::uuid as game, (:'f'::jsonb ->> 'admin')::uuid as admin, (:'f'::jsonb ->> 'league')::uuid as league,
       (:'f'::jsonb ->> 'team_a')::uuid as team_a \gset
select tests.create_user(false) as other_admin \gset
select tests.create_user(true) as scorer \gset
select tests.create_user(true) as outsider \gset
select email as other_email from auth.users where id = :'other_admin' \gset
insert into public.game_scorers (game_id, user_id, device_id) values (:'game', :'scorer', 'dev-1');

-- Players carry a default jersey used to pre-fill game rosters.
select tests.login(:'admin');
select lives_ok(format($$ insert into public.players (team_id, name, default_jersey) values (%L, 'New Player', '23') $$, :'team_a'), 'admin adds a player with a default jersey');

-- Co-admins by email.
select is(public.add_league_admin(:'league', :'other_email'), true, 'admin adds a co-admin by email');
select tests.login(:'other_admin');
select is((select count(*)::int from public.games), 1, 'the co-admin sees the league''s game');
select tests.login(:'admin');
select is(public.add_league_admin(:'league', 'nobody@nowhere.test'), false, 'unknown email: false, nothing added');
select tests.login(:'scorer');
select throws_ok(format($$ select public.add_league_admin(%L, 'x@y.z') $$, :'league'), '42501', null, 'non-admins cannot add admins');

-- Latency samples: scorer devices record, admins read, nobody else does either.
select tests.login(:'scorer');
select lives_ok(format($$ select public.record_latency(%L, 'dev-1', '[{"kind":"render","ms":12.5},{"kind":"peer","ms":80}]') $$, :'game'), 'a scorer records latency samples');
select is((select count(*)::int from public.latency_samples), 0, 'scorers cannot read samples back');
select tests.login(:'outsider');
select throws_ok(format($$ select public.record_latency(%L, 'dev-x', '[{"kind":"render","ms":1}]') $$, :'game'), '42501', null, 'non-members cannot record');
select tests.login(:'admin');
select is((select count(*)::int from public.latency_samples where game_id = :'game'), 2, 'the admin reads the game''s samples');
select is((select avg(ms)::numeric from public.latency_samples where kind = 'render'), 12.5, 'samples keep their values');
select tests.login(:'scorer');
select throws_ok(format($$ select public.record_latency(%L, 'dev-1', '[{"kind":"bogus","ms":1}]') $$, :'game'), '23514', null, 'unknown sample kinds are rejected');
select throws_ok(format($$ select public.record_latency(%L, 'dev-1', (select jsonb_agg(jsonb_build_object('kind','render','ms',1)) from generate_series(1, 501))) $$, :'game'), '22023', null, 'batches are capped at 500 samples');

select * from finish();
rollback;
