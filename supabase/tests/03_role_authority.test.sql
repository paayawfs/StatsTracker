begin;
select plan(22);

select tests.game_fixture('multi') as f \gset
select (:'f'::jsonb ->> 'game')::uuid as game, (:'f'::jsonb ->> 'admin')::uuid as admin,
       :'f'::jsonb -> 'a' ->> 0 as a1, :'f'::jsonb -> 'b' ->> 0 as b1 \gset
select tests.create_user(true) as sa \gset
select tests.create_user(true) as sb \gset
select tests.create_user(true) as sc \gset
insert into public.game_scorers (game_id, user_id, device_id) values
  (:'game', :'sa', 'dev-a'), (:'game', :'sb', 'dev-b'), (:'game', :'sc', 'dev-c');

create function pg_temp.write(uid uuid, ev jsonb) returns text language plpgsql as $$
begin
  perform tests.login(uid);
  perform public.insert_event(ev);
  return 'ok';
exception when others then
  return sqlstate;
end $$;

-- Claims are exclusive.
select is(pg_temp.write(:'sa', tests.event(:'game', 'roleClaim', 'teamA', '{"role":"teamA"}')), 'ok', 'A claims teamA');
select is(pg_temp.write(:'sb', tests.event(:'game', 'roleClaim', 'teamA', '{"role":"teamA"}')), '23505', 'second claim on teamA is rejected');
select is(pg_temp.write(:'sb', tests.event(:'game', 'roleClaim', 'teamB', '{"role":"teamB"}')), 'ok', 'B claims teamB');
select is(pg_temp.write(:'sa', tests.event(:'game', 'roleClaim', 'single', '{"role":"single"}')), '42501', 'single role is not used in multi mode');

-- Must hold the role you write as.
select is(pg_temp.write(:'sc', tests.event(:'game', 'checkpoint', 'teamA', '{"score":{"A":0,"B":0}}')), '42501', 'writing as an unheld role is rejected');

-- Ownership: shooting team owns shots and free throws.
select is(pg_temp.write(:'sa', tests.event(:'game', 'shot', 'teamA', jsonb_build_object('shooter', :'a1', 'value', 2, 'made', true))), 'ok', 'teamA writes A shot');
select is(pg_temp.write(:'sa', tests.event(:'game', 'shot', 'teamA', jsonb_build_object('shooter', :'b1', 'value', 2, 'made', true))), '42501', 'teamA cannot write B shot');
select is(pg_temp.write(:'sb', tests.event(:'game', 'freeThrow', 'teamB', jsonb_build_object('shooter', :'b1', 'made', true, 'attempt', 1, 'of', 1))), 'ok', 'teamB writes B free throw');

-- Fouling team owns fouls; rebounding team owns rebounds.
select is(pg_temp.write(:'sb', tests.event(:'game', 'foul', 'teamB', jsonb_build_object('team', 'B', 'offender', 'player', 'player', :'b1', 'kind', 'personal', 'fouled', :'a1', 'freeThrows', 0))), 'ok', 'teamB writes B foul');
select is(pg_temp.write(:'sa', tests.event(:'game', 'rebound', 'teamA', '{"team":"B","kind":"defensive"}')), '42501', 'teamA cannot write B rebound');

-- Game control: team A without a clock role, the clock role once claimed.
select is(pg_temp.write(:'sa', tests.event(:'game', 'clockStart', 'teamA')), 'ok', 'teamA runs the clock when no clock role');
select is(pg_temp.write(:'sc', tests.event(:'game', 'roleClaim', 'clock', '{"role":"clock"}')), 'ok', 'C claims clock');
select is(pg_temp.write(:'sa', tests.event(:'game', 'clockStop', 'teamA')), '42501', 'teamA loses the clock once claimed');
select is(pg_temp.write(:'sc', tests.event(:'game', 'timeout', 'clock', '{"team":"B"}')), 'ok', 'clock writes timeouts');

-- Any scorer may correct.
select is(pg_temp.write(:'sb', tests.event(:'game', 'void', 'teamB', jsonb_build_object('targetId', gen_random_uuid()))), 'ok', 'teamB may void any event');

-- Transfer: C's device fails, A takes the clock role.
select is(pg_temp.write(:'sa', tests.event(:'game', 'roleTransfer', 'clock', '{"role":"clock","toDeviceId":"dev-a"}')), 'ok', 'A takes over the clock role');
select is(pg_temp.write(:'sa', tests.event(:'game', 'clockStop', 'clock')), 'ok', 'A now writes as clock');

-- A replacement device holding no role can take one over (dead device at a stoppage).
select tests.as_postgres();
select tests.create_user(true) as sd \gset
insert into public.game_scorers (game_id, user_id, device_id) values (:'game', :'sd', 'dev-d');
select is(pg_temp.write(:'sd', tests.event(:'game', 'roleTransfer', 'teamB', '{"role":"teamB","toDeviceId":"dev-d"}')), 'ok', 'a device with no role takes over teamB');
select is(pg_temp.write(:'sd', tests.event(:'game', 'rebound', 'teamB', '{"team":"B","kind":"defensive"}')), 'ok', 'and now writes as teamB');
select is(pg_temp.write(:'sb', tests.event(:'game', 'rebound', 'teamB', '{"team":"B","kind":"defensive"}')), '42501', 'the old teamB device no longer can');

-- Lock: only admins after it.
select is(pg_temp.write(:'admin', tests.event(:'game', 'adminLock', 'admin')), 'ok', 'admin locks the game');
select is(pg_temp.write(:'sa', tests.event(:'game', 'void', 'teamA', jsonb_build_object('targetId', gen_random_uuid()))), '42501', 'scorers cannot write after lock');

select * from finish();
rollback;
