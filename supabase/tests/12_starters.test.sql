begin;
select plan(5);

select tests.game_fixture('multi') as f \gset
select (:'f'::jsonb ->> 'game')::uuid as game, :'f'::jsonb -> 'a' ->> 0 as a1 \gset
select tests.create_user(true) as sa \gset
select tests.create_user(true) as sb \gset
insert into public.game_scorers (game_id, user_id, device_id) values (:'game', :'sa', 'dev-a'), (:'game', :'sb', 'dev-b');

create function pg_temp.write(uid uuid, ev jsonb) returns text language plpgsql as $$
begin
  perform tests.login(uid);
  perform public.insert_event(ev);
  return 'ok';
exception when others then
  return sqlstate;
end $$;

select is(pg_temp.write(:'sa', tests.event(:'game', 'roleClaim', 'teamA', '{"role":"teamA"}')), 'ok', 'A claims teamA');
select is(pg_temp.write(:'sb', tests.event(:'game', 'roleClaim', 'teamB', '{"role":"teamB"}')), 'ok', 'B claims teamB');
select format('{"lineups":{"A":["%s"],"B":[]}}', :'a1') as picks \gset

select is(pg_temp.write(:'sa', tests.event(:'game', 'starters', 'teamA', :'picks')), 'ok', 'game control (Team A, no clock) records starters');
select is(pg_temp.write(:'sb', tests.event(:'game', 'starters', 'teamB', :'picks')), '42501', 'Team B is not game control');
select is(pg_temp.write(:'sb', tests.event(:'game', 'starters', 'teamB', '{"lineups":{"A":[]}}')), '22023', 'a malformed lineup is refused');

select * from finish();
rollback;
