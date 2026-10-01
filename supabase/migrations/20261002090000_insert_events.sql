-- Batched durable path (2026-10-02): a device's outbox in one round trip instead of one per event.
-- Each event goes through insert_event (schema, authority, idempotency, seq) in its own
-- subtransaction, so a refused event doesn't take the rest of the batch with it. Returns one
-- result per event, in order: {"seq": n} or {"code": sqlstate, "message": text}.

create function public.insert_events(events jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  e jsonb;
  results jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(events) <> 'array' or jsonb_array_length(events) > 100 then
    raise exception 'events must be an array of at most 100' using errcode = '22023';
  end if;
  for e in select value from jsonb_array_elements(events) loop
    begin
      results := results || jsonb_build_array(jsonb_build_object('seq', public.insert_event(e)));
    exception when others then
      results := results || jsonb_build_array(jsonb_build_object('code', sqlstate, 'message', sqlerrm));
    end;
  end loop;
  return results;
end $$;

revoke execute on function public.insert_events(jsonb) from public, anon;
grant execute on function public.insert_events(jsonb) to authenticated;
