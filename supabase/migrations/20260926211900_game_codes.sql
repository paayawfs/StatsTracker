-- Scorers join a game with a short code after anonymous sign-in.

-- 8 chars from a 32-char alphabet without 0/O/1/I: ~10^12 codes. Brute force is impractical, so
-- ponytail: no attempt limiter. Add one if codes get shorter.
create function public.create_game_code(game uuid, valid_for interval default interval '1 day') returns text
language plpgsql security definer set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := extensions.gen_random_bytes(8);
  new_code text;
begin
  if not exists (select 1 from public.games g where g.id = game and public.is_league_admin(g.league_id)) then
    raise exception 'only league admins can create codes' using errcode = '42501';
  end if;
  select string_agg(substr(alphabet, get_byte(bytes, i) % 32 + 1, 1), '') into new_code from generate_series(0, 7) i;
  insert into public.game_codes (code, game_id, expires_at) values (new_code, game, now() + valid_for);
  return new_code;
end $$;

-- Revoking a code also removes every scorer who joined with it, and their roles.
create function public.revoke_game_code(revoked text) returns void
language plpgsql security definer set search_path = '' as $$
declare game uuid;
begin
  select c.game_id into game from public.game_codes c join public.games g on g.id = c.game_id
    where c.code = revoked and public.is_league_admin(g.league_id);
  if game is null then
    raise exception 'only league admins can revoke codes' using errcode = '42501';
  end if;
  update public.game_codes set revoked_at = now() where code = revoked;
  delete from public.role_claims rc using public.game_scorers s
    where s.code = revoked and rc.game_id = s.game_id and rc.user_id = s.user_id;
  delete from public.game_scorers where code = revoked;
end $$;

-- Join as a scorer. Call after supabase.auth.signInAnonymously(). Returns the game id.
create function public.join_game(join_code text, device text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare c public.game_codes;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into c from public.game_codes where code = upper(join_code);
  if not found or c.revoked_at is not null or c.expires_at < now()
     or exists (select 1 from public.games g where g.id = c.game_id and g.locked_at is not null) then
    raise exception 'invalid or expired code' using errcode = '42501';
  end if;
  insert into public.game_scorers (game_id, user_id, device_id, code) values (c.game_id, auth.uid(), device, c.code)
    on conflict (game_id, user_id) do update set device_id = excluded.device_id, code = excluded.code;
  return c.game_id;
end $$;

revoke execute on function public.create_game_code(uuid, interval), public.revoke_game_code(text), public.join_game(text, text) from public, anon;
grant execute on function public.create_game_code(uuid, interval), public.revoke_game_code(text), public.join_game(text, text) to authenticated;
