begin;
select plan(3);

select tests.game_fixture('single') as f \gset
select (:'f'::jsonb ->> 'game')::uuid as game, (:'f'::jsonb ->> 'admin')::uuid as admin \gset
select tests.create_user(true) as scorer \gset

-- A scorer joins and holds the role before the game is locked.
select tests.login(:'admin');
select public.create_game_code(:'game') as code \gset
select tests.login(:'scorer');
select public.join_game(:'code', 'dev-s');
select public.insert_event(tests.event(:'game', 'roleClaim', 'single', '{"role":"single"}'));

select tests.login(:'admin');
select gen_random_uuid() as lock \gset
select public.insert_event(tests.event(:'game', 'adminLock', 'admin', '{}', :'lock'));
select isnt((select locked_at from public.games where id = :'game'), null, 'the lock sets locked_at');

-- Scorers can't lift a lock.
select tests.login(:'scorer');
select throws_ok(format($$ select public.insert_event(tests.event(%L, 'void', 'single', %L)) $$, :'game', jsonb_build_object('targetId', :'lock')),
  '42501', null, 'scorers cannot unlock');

select tests.login(:'admin');
select public.insert_event(tests.event(:'game', 'void', 'admin', jsonb_build_object('targetId', :'lock')));
select tests.as_postgres();
select is((select locked_at from public.games where id = :'game'), null, 'an admin void of the lock clears it');

select * from finish();
rollback;
