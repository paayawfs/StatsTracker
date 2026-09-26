begin;
select plan(9);

select tests.game_fixture('single') as f \gset
select (:'f'::jsonb ->> 'game')::uuid as game, (:'f'::jsonb ->> 'admin')::uuid as admin \gset
select tests.create_user(true) as scorer \gset
select tests.create_user(true) as outsider \gset
insert into public.game_scorers (game_id, user_id, device_id) values (:'game', :'scorer', 'dev-1');

-- A scorer can write; seq starts at 1 and increases.
select tests.login(:'scorer');
select is(public.insert_event(tests.event(:'game', 'roleClaim', 'single', '{"role":"single"}')), 1::bigint, 'first event gets seq 1');
select is(public.insert_event(tests.event(:'game', 'clockStart', 'single')), 2::bigint, 'second event gets seq 2');

-- Resending the same id is idempotent.
select tests.event(:'game', 'timeout', 'single', '{"team":"A"}') as ev \gset
select is(public.insert_event(:'ev'), 3::bigint, 'new event gets seq 3');
select is(public.insert_event(:'ev'), 3::bigint, 'resend returns the same seq');
select tests.as_postgres();
select is((select count(*)::int from public.events where game_id = :'game'), 3, 'resend did not insert a second row');

-- Schema is enforced at the boundary.
select tests.login(:'scorer');
select throws_ok(
  format($$ select public.insert_event(%L) $$, tests.event(:'game', 'timeout', 'single', '{"team":"C"}')),
  '22023', null, 'payload that fails the schema is rejected'
);

-- Outsiders and anonymous callers cannot write.
select tests.login(:'outsider');
select throws_ok(
  format($$ select public.insert_event(%L) $$, tests.event(:'game', 'clockStart', 'single')),
  '42501', null, 'a signed-in non-member is rejected'
);
select tests.as_anon();
select throws_ok(
  format($$ select public.insert_event(%L) $$, tests.event(:'game', 'clockStart', 'single')),
  '42501', null, 'anon cannot call insert_event'
);

-- The admin of the league can write too.
select tests.login(:'admin');
select is(public.insert_event(tests.event(:'game', 'clockStart', 'admin')), 4::bigint, 'league admin can write');

select * from finish();
rollback;
