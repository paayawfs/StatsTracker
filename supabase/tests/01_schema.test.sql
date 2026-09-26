begin;
select plan(8);

select has_table('public', t, t || ' exists')
from unnest(array['leagues', 'games', 'events']) t;

select is(
  (select count(*)::int from pg_tables where schemaname = 'public' and not rowsecurity),
  0,
  'every public table has RLS enabled'
);

-- Append-only: even the table owner cannot change or remove events.
select tests.game_fixture() as f \gset
insert into public.events (id, game_id, seq, device_id, device_seq, role, period, game_clock, wall_clock, type, payload)
values (gen_random_uuid(), (:'f'::jsonb ->> 'game')::uuid, 1, 'dev', 0, 'single', 1, 600000, 1, 'clockStart', '{}');

select throws_ok($$ update public.events set period = 2 $$, '42501', null, 'update is rejected');
select throws_ok($$ delete from public.events $$, '42501', null, 'delete is rejected');
select throws_ok($$ truncate public.events $$, '42501', null, 'truncate is rejected');

select is(
  (select extensions.jsonb_matches_schema(public.event_json_schema(), '{"type":"nonsense"}'::jsonb)),
  false,
  'event JSON Schema rejects garbage'
);

select * from finish();
rollback;
