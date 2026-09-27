begin;
select plan(6);

select tests.game_fixture('single') as f \gset
select (:'f'::jsonb ->> 'game')::uuid as game, (:'f'::jsonb ->> 'admin')::uuid as admin \gset
select tests.create_user(true) as scorer \gset
select tests.create_user(true) as fresh \gset

select tests.login(:'admin');
select public.create_game_code(:'game') as code \gset

select tests.login(:'scorer');
select public.join_game(:'code', 'dev-1');
select gen_random_uuid() as claim \gset
select public.insert_event(tests.event(:'game', 'roleClaim', 'single', '{"role":"single"}', :'claim'));

-- Corrections are for play events only.
select throws_ok(format($$ select public.insert_event(tests.event(%L, 'void', 'single', %L)) $$, :'game', jsonb_build_object('targetId', :'claim')),
  '42501', null, 'a role claim cannot be voided');
select gen_random_uuid() as shot \gset
select public.insert_event(tests.event(:'game', 'shot', 'single', '{"shooter":"p1","value":2,"made":true}', :'shot'));
select lives_ok(format($$ select public.insert_event(tests.event(%L, 'void', 'single', %L)) $$, :'game', jsonb_build_object('targetId', :'shot')),
  'a shot can be voided');

-- Same device, new anonymous session (the old one was lost): it takes over its seat and roles.
select tests.login(:'fresh');
select is(public.join_game(:'code', 'dev-1'), :'game'::uuid, 'rejoining from the same device under a new user works');
select tests.as_postgres();
select is((select user_id from public.game_scorers where game_id = :'game' and device_id = 'dev-1'), :'fresh'::uuid, 'the device seat moves to the new user');
select is((select user_id from public.role_claims where game_id = :'game' and role = 'single'), :'fresh'::uuid, 'and so does its role');
select tests.login(:'fresh');
select lives_ok(format($$ select public.insert_event(tests.event(%L, 'clockStart', 'single')) $$, :'game'), 'the device can score again');

select * from finish();
rollback;
