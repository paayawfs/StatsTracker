begin;
select plan(2);

select tests.as_anon();
select ok(abs(public.server_now() - (extract(epoch from clock_timestamp()) * 1000)::bigint) < 1000, 'server_now is epoch ms');
select ok(public.server_now() <= public.server_now(), 'server_now does not go backwards within a call sequence');

select * from finish();
rollback;
