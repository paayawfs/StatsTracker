begin;
select plan(5);

select tests.game_fixture('single') as f \gset
select (:'f'::jsonb ->> 'admin')::uuid as admin, :'f'::jsonb ->> 'slug' as slug, :'f'::jsonb -> 'a' ->> 0 as a1 \gset

select tests.login(:'admin');
select lives_ok(format($$ update public.players set photo = 'data:image/webp;base64,UklGRg==' where id = %L $$, :'a1'), 'admin sets a small image photo');
select throws_ok(format($$ update public.players set photo = 'https://example.com/x.jpg' where id = %L $$, :'a1'), '23514', null, 'only inline image data is accepted');
select throws_ok(format($$ update public.players set photo = 'data:image/webp;base64,' || repeat('A', 40000) where id = %L $$, :'a1'), '23514', null, 'photos are capped in size');

-- Viewers see the photo through the public game info.
select tests.as_anon();
select is((select r ->> 'photo' from jsonb_array_elements(public.public_game(:'slug') -> 'roster') r where r ->> 'playerId' = :'a1'), 'data:image/webp;base64,UklGRg==', 'public_game includes the photo');
select is((select count(*)::int from jsonb_array_elements(public.public_game(:'slug') -> 'roster') r where r ? 'photo'), 16, 'every roster entry has a photo key (null when none)');

select * from finish();
rollback;
