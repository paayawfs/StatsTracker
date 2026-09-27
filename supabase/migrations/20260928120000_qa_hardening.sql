-- QA hardening (2026-09-28).
-- 1. join_game: a device that lost its anonymous session rejoins under a new user. The old
--    (game, device) row made the insert fail on unique (game_id, device_id); now the device's seat
--    and roles move to the new user. Any joined scorer can already take over any role, so this
--    grants nothing new.
-- 2. authorize_event: amend/void may not target session events (role claims, locks) or other
--    corrections. Everything else is unchanged from 20260927120000.

create or replace function public.join_game(join_code text, device text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.game_codes;
  previous uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into c from public.game_codes where code = upper(join_code);
  if not found or c.revoked_at is not null or c.expires_at < now()
     or exists (select 1 from public.games g where g.id = c.game_id and g.locked_at is not null) then
    raise exception 'invalid or expired code' using errcode = '42501';
  end if;
  select s.user_id into previous from public.game_scorers s
    where s.game_id = c.game_id and s.device_id = device and s.user_id <> auth.uid();
  if previous is not null then
    delete from public.game_scorers s where s.game_id = c.game_id and s.user_id = previous;
    delete from public.game_scorers s where s.game_id = c.game_id and s.user_id = auth.uid();
    update public.role_claims rc set user_id = auth.uid() where rc.game_id = c.game_id and rc.user_id = previous;
  end if;
  insert into public.game_scorers (game_id, user_id, device_id, code) values (c.game_id, auth.uid(), device, c.code)
    on conflict (game_id, user_id) do update set device_id = excluded.device_id, code = excluded.code;
  return c.game_id;
end $$;

create or replace function public.authorize_event(g public.games, event jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  uid uuid := auth.uid();
  r text := event ->> 'role';
  typ text := event ->> 'type';
  p jsonb := event -> 'payload';
  owner text;
  target uuid;
begin
  if r = 'admin' then
    if not public.is_league_admin(g.league_id) then
      raise exception 'the admin role requires a league admin' using errcode = '42501';
    end if;
    if typ = 'adminLock' then
      update public.games set locked_at = now() where id = g.id;
    end if;
    return;
  end if;

  if g.locked_at is not null then
    raise exception 'game is locked: only admins can write' using errcode = '42501';
  end if;
  if typ = 'adminLock' then
    raise exception 'only admins can lock a game' using errcode = '42501';
  end if;
  if (r = 'single') <> (g.mode = 'single') then
    raise exception 'role % is not used in % mode', r, g.mode using errcode = '42501';
  end if;

  if typ = 'roleClaim' then
    if p ->> 'role' <> r then
      raise exception 'a claim must be written as the claimed role' using errcode = '22023';
    end if;
    insert into public.role_claims (game_id, role, user_id) values (g.id, r, uid) on conflict do nothing;
    if not exists (select 1 from public.role_claims c where c.game_id = g.id and c.role = r and c.user_id = uid) then
      raise exception 'role % is already held', r using errcode = '23505';
    end if;
    return;
  end if;

  -- Any joined scorer (insert_event already checked membership) may move any role.
  if typ = 'roleTransfer' then
    if p ->> 'role' <> r then
      raise exception 'a transfer must be written as the transferred role' using errcode = '22023';
    end if;
    select s.user_id into target from public.game_scorers s where s.game_id = g.id and s.device_id = p ->> 'toDeviceId';
    if target is null then
      raise exception 'device % has not joined this game', p ->> 'toDeviceId' using errcode = '22023';
    end if;
    insert into public.role_claims (game_id, role, user_id) values (g.id, r, target)
      on conflict (game_id, role) do update set user_id = excluded.user_id, claimed_at = now();
    return;
  end if;

  if not exists (select 1 from public.role_claims c where c.game_id = g.id and c.role = r and c.user_id = uid) then
    raise exception 'you do not hold role %', r using errcode = '42501';
  end if;

  case typ
    when 'roleRelease' then
      delete from public.role_claims c where c.game_id = g.id and c.role = p ->> 'role' and c.user_id = uid;
      if not found then
        raise exception 'you do not hold role %', p ->> 'role' using errcode = '42501';
      end if;
      return;
    when 'amend', 'void' then
      -- Corrections are for play events. Correcting a role claim or a lock would make clients and
      -- role_claims disagree on who holds a role. (An unknown target may be a peer's event still in
      -- flight, so it passes; clients ignore corrections of events they never get.)
      if exists (select 1 from public.events e where e.game_id = g.id and e.id::text = p ->> 'targetId'
                 and e.type in ('roleClaim', 'roleRelease', 'roleTransfer', 'adminLock', 'amend', 'void')) then
        raise exception 'only play events can be corrected' using errcode = '42501';
      end if;
      return;
    when 'checkpoint' then
      return;
    else
      null;
  end case;

  if r = 'single' then
    return;
  end if;

  owner := case
    when typ in ('gameStart', 'periodStart', 'periodEnd', 'gameEnd', 'clockStart', 'clockStop', 'timeout', 'jumpBall', 'possessionArrow') then
      case when exists (select 1 from public.role_claims c where c.game_id = g.id and c.role = 'clock') then 'clock' else 'teamA' end
    when typ in ('substitution', 'rebound', 'turnover', 'foul') then 'team' || (p ->> 'team')
    when typ in ('shot', 'freeThrow') then
      coalesce((select 'team' || gr.team from public.game_roster gr where gr.game_id = g.id and gr.player_id::text = p ->> 'shooter'), r)
  end;

  if owner is distinct from r then
    raise exception '% events belong to role %, not %', typ, owner, r using errcode = '42501';
  end if;
end $$;
