begin;
select plan(11);

select tests.game_fixture('single') as f \gset
select (:'f'::jsonb ->> 'game')::uuid as game, (:'f'::jsonb ->> 'admin')::uuid as admin \gset
select tests.create_user(true) as scorer \gset
select tests.create_user(true) as other \gset

-- Only admins create codes.
select tests.login(:'scorer');
select throws_ok(format($$ select public.create_game_code(%L) $$, :'game'), '42501', null, 'scorers cannot create codes');

select tests.login(:'admin');
select public.create_game_code(:'game') as code \gset
select matches(:'code'::text, '^[A-HJ-NP-Z2-9]{8}$', 'code is 8 unambiguous characters');

-- Join with the code (case-insensitive), then write.
select tests.login(:'scorer');
select is(public.join_game(lower(:'code'), 'dev-1'), :'game'::uuid, 'join returns the game id');
select is(public.insert_event(tests.event(:'game', 'roleClaim', 'single', '{"role":"single"}')), 1::bigint, 'joined scorer can claim a role');
select is(public.join_game(:'code', 'dev-1'), :'game'::uuid, 'joining twice is harmless');

select throws_ok($$ select public.join_game('ZZZZZZZZ', 'dev-2') $$, '42501', null, 'unknown code is rejected');

-- Expired codes are rejected.
select tests.login(:'admin');
select public.create_game_code(:'game', interval '-1 second') as expired \gset
select tests.login(:'other');
select throws_ok(format($$ select public.join_game(%L, 'dev-2') $$, :'expired'), '42501', null, 'expired code is rejected');

-- Revoking removes the scorer and their role.
select tests.login(:'admin');
select public.revoke_game_code(:'code');
select tests.as_postgres();
select is((select count(*)::int from public.game_scorers where user_id = :'scorer'), 0, 'revoked scorer is removed');
select is((select count(*)::int from public.role_claims where user_id = :'scorer'), 0, 'revoked scorer loses roles');
select tests.login(:'scorer');
select throws_ok(format($$ select public.join_game(%L, 'dev-1') $$, :'code'), '42501', null, 'revoked code cannot be reused');

-- Locked games cannot be joined.
select tests.login(:'admin');
select public.create_game_code(:'game') as fresh \gset
select public.insert_event(tests.event(:'game', 'adminLock', 'admin'));
select tests.login(:'other');
select throws_ok(format($$ select public.join_game(%L, 'dev-2') $$, :'fresh'), '42501', null, 'locked game cannot be joined');

select * from finish();
rollback;
