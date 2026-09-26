-- Server clock for client offset estimation (game clock and latency measurements).
create function public.server_now() returns bigint
language sql volatile set search_path = '' as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint
$$;
grant execute on function public.server_now() to anon, authenticated;
