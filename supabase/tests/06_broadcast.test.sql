begin;
select plan(13);

select tests.game_fixture('single') as f \gset
select (:'f'::jsonb ->> 'game')::uuid as game, (:'f'::jsonb ->> 'admin')::uuid as admin, :'f'::jsonb ->> 'slug' as slug \gset
select tests.create_user(true) as scorer \gset
select tests.create_user(true) as outsider \gset
insert into public.game_scorers (game_id, user_id, device_id) values (:'game', :'scorer', 'dev-1');
insert into public.role_claims values (:'game', 'single', :'scorer');

-- Each durable event is broadcast to the scorer and viewer channels in core JSON shape.
select tests.login(:'scorer');
select tests.event(:'game', 'timeout', 'single', '{"team":"B"}') as ev \gset
select public.insert_event(:'ev');
select tests.as_postgres();
select is((select count(*)::int from realtime.messages where topic = 'game:' || :'game'), 1, 'broadcast on the scorer channel');
select is((select count(*)::int from realtime.messages where topic = 'view:' || :'slug'), 1, 'broadcast on the viewer channel');
select is(
  (select payload - 'seq' from realtime.messages where topic = 'game:' || :'game'),
  :'ev'::jsonb - 'seq',
  'broadcast payload is the event as written'
);
select is((select (payload ->> 'seq')::int from realtime.messages where topic = 'game:' || :'game'), 1, 'broadcast carries the durable seq');
select ok((select bool_and(private) from realtime.messages), 'both channels are private');

-- Channel authorization (Realtime evaluates these policies with realtime.topic() set).
create function pg_temp.can_read(topic text) returns boolean language plpgsql as $$
begin
  perform set_config('realtime.topic', topic, true);
  return exists (select 1 from realtime.messages m where m.topic = can_read.topic);
end $$;
create function pg_temp.can_send(topic text) returns boolean language plpgsql as $$
begin
  perform set_config('realtime.topic', topic, true);
  insert into realtime.messages (topic, extension, event, payload, private) values (topic, 'broadcast', 'event', '{}', true);
  return true;
exception when insufficient_privilege then
  return false;
end $$;

select tests.login(:'scorer');
select ok(pg_temp.can_read('game:' || :'game'), 'scorer receives on the scorer channel');
select ok(pg_temp.can_send('game:' || :'game'), 'scorer sends on the scorer channel (fast path)');
select tests.login(:'outsider');
select ok(not pg_temp.can_read('game:' || :'game'), 'outsider cannot receive scorer broadcasts');
select ok(not pg_temp.can_send('game:' || :'game'), 'outsider cannot send scorer broadcasts');
select tests.as_anon();
select ok(pg_temp.can_read('view:' || :'slug'), 'anonymous viewer receives with the slug');
select ok(not pg_temp.can_send('view:' || :'slug'), 'viewers cannot send on the viewer channel');

-- Public read functions work by slug only.
select is((public.public_game(:'slug') -> 'teams' ->> 'A'), 'Team A', 'public_game returns team names');
select is((select count(*)::int from public.public_events(:'slug', 0)), 1, 'public_events returns events by slug');

select * from finish();
rollback;
