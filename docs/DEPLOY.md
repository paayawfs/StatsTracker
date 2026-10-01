# Deploying to Vercel

Live (2026-10-01): scorer `https://stats-scorer.vercel.app` (admin at `/admin`), viewer
`https://stats-viewer-mocha.vercel.app`. Vercel projects `stats-scorer` and `stats-viewer`
(account `paayawfs`), both linked to GitHub, so a push to `main` deploys both.

Two Vercel projects from the one repo (`paayawfs/StatsTracker`), both static Vite builds:

| Project | Root directory | Serves | Env vars |
|---|---|---|---|
| viewer | `apps/public` | `/g/<slug>` public game pages | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
| scorer | `apps/scorer` | `/` scorer, `/admin` league admin | the same two, plus `VITE_PUBLIC_URL` (the viewer's URL) |

A Vercel build stops with "… is not set in Vercel" if one is missing, rather than shipping an app
that talks to `127.0.0.1`.

## 1. Viewer project (first: the scorer needs its URL)

1. vercel.com → Add New → Project → import `paayawfs/StatsTracker`.
2. Root Directory: `apps/public`. Framework: Vite (detected). Leave build/install/output as detected:
   Vercel installs with pnpm from the repo root and builds into `dist`.
3. Environment variables (Production and Preview):
   - `VITE_SUPABASE_URL` = `https://uulqbabkuqgumljonupy.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = Supabase dashboard → Project Settings → API Keys → the `anon` (public)
     key. Never the `service_role` / secret key: this one ships to every browser.
4. Deploy. Note the URL, e.g. `https://stats-viewer.vercel.app`.

## 2. Scorer project

Same steps with Root Directory `apps/scorer`, the same two Supabase variables, and
`VITE_PUBLIC_URL` = the viewer URL from step 1 (no trailing slash). Note this URL too, e.g.
`https://stats-scorer.vercel.app`.

## 3. Supabase dashboard (project `uulqbabkuqgumljonupy`)

- **Authentication → Sign In / Providers → Allow anonymous sign-ins: on.** Scorers join with a game
  code as anonymous users. It's off by default on hosted projects; without it "Join game" fails.
- **Authentication → URL Configuration**
  - Site URL: the scorer URL.
  - Redirect URLs: add `https://<scorer>/admin`. Sign-up confirmation emails land there.
- **Admin accounts.** Supabase's built-in email only reaches the project's team members and a few
  per hour. Until custom SMTP is set up (Authentication → Emails → SMTP, e.g. Resend), create
  admins under Authentication → Users → Add user → Create new user, with "Auto Confirm User" ticked.
  They then sign in at `/admin`.

CORS needs nothing: Supabase's API, auth and realtime accept browser calls from any origin with
the anon key, and Row Level Security plus the database functions decide what each user may do.

## 4. Smoke test

1. `https://<scorer>/admin`: sign in, create a league, rule set, two teams, a game, a scorer code.
2. On a phone: `https://<scorer>`, join with the code, pick starters, score a basket.
3. Open the viewer link from the admin game page on another phone: the score arrives within ~2 s.
4. Phone in airplane mode: keep scoring, reload, then reconnect; the admin page catches up.

## Later deploys

Push to `main`: both projects rebuild. Hashed files under `/assets` are cached for a year
(`vercel.json`); `index.html` and `sw.js` are revalidated, so phones pick up a new release on the
next load with a connection. Database changes go first: `npx supabase db push`, then push the code.
