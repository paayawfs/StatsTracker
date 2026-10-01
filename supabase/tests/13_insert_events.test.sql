begin;
select plan(6);

select tests.game_fixture('single') as f \gset
select (:'f'::jsonb ->> 'game')::uuid as game \gset
select tests.create_user(true) as scorer \gset
insert into public.game_scorers (game_id, user_id, device_id) values (:'game', :'scorer', 'dev-1');

select tests.login(:'scorer');
select tests.event(:'game', 'clockStart', 'single') as start \gset

-- In order, in one call: a claim, then events that need it.
select is(
  public.insert_events(jsonb_build_array(tests.event(:'game', 'roleClaim', 'single', '{"role":"single"}'), :'start'::jsonb)),
  '[{"seq": 1}, {"seq": 2}]'::jsonb,
  'a batch gets consecutive seqs in order'
);

-- A refused event in the middle: the others still go in, and it reports why.
select public.insert_events(jsonb_build_array(
  tests.event(:'game', 'timeout', 'single', '{"team":"A"}'),
  tests.event(:'game', 'timeout', 'single', '{"team":"C"}'),
  tests.event(:'game', 'clockStop', 'single')
)) as r \gset
select is((:'r'::jsonb -> 0 ->> 'seq')::int, 3, 'event before the bad one is stored');
select is(:'r'::jsonb -> 1 ->> 'code', '22023', 'the bad one is refused with its code');
select is((:'r'::jsonb -> 2 ->> 'seq')::int, 4, 'event after the bad one is stored');

-- Resending (a lost ack) returns the same seq.
select is(public.insert_events(jsonb_build_array(:'start'::jsonb)), '[{"seq": 2}]'::jsonb, 'a resend is idempotent');

select tests.as_anon();
select throws_ok(format($$ select public.insert_events(%L) $$, jsonb_build_array(:'start'::jsonb)), '42501', null, 'anon cannot call insert_events');

select * from finish();
rollback;
