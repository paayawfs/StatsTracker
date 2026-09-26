-- Role authority for insert_event: who may write which event (brief section 6 "Ownership" + 7).

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
  -- Admins may write anything, including after the lock.
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

  -- Claims are exclusive: the primary key on role_claims decides races.
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
    when 'roleTransfer' then
      -- ponytail: any role holder in the game may move any role, so a dead device's role can be
      -- taken over. The transfer is an event, so it is auditable. Tighten if abused.
      select s.user_id into target from public.game_scorers s where s.game_id = g.id and s.device_id = p ->> 'toDeviceId';
      if target is null then
        raise exception 'device % has not joined this game', p ->> 'toDeviceId' using errcode = '22023';
      end if;
      insert into public.role_claims (game_id, role, user_id) values (g.id, p ->> 'role', target)
        on conflict (game_id, role) do update set user_id = excluded.user_id, claimed_at = now();
      return;
    when 'amend', 'void', 'checkpoint' then
      return; -- any scorer may correct or reconcile
    else
      null;
  end case;

  if r = 'single' then
    return; -- single mode: one device holds everything
  end if;

  owner := case
    when typ in ('gameStart', 'periodStart', 'periodEnd', 'gameEnd', 'clockStart', 'clockStop', 'timeout', 'jumpBall', 'possessionArrow') then
      case when exists (select 1 from public.role_claims c where c.game_id = g.id and c.role = 'clock') then 'clock' else 'teamA' end
    when typ in ('substitution', 'rebound', 'turnover', 'foul') then 'team' || (p ->> 'team')
    when typ in ('shot', 'freeThrow') then
      -- ponytail: a shooter missing from game_roster (added late via gameStart amend) can't be
      -- attributed, so any team role may write it. core still flags unknown players.
      coalesce((select 'team' || gr.team from public.game_roster gr where gr.game_id = g.id and gr.player_id::text = p ->> 'shooter'), r)
  end;

  if owner is distinct from r then
    raise exception '% events belong to role %, not %', typ, owner, r using errcode = '42501';
  end if;
end $$;
