# Dev Notes

Running log of decisions and what each step built. Newest step at the bottom.

## Decisions agreed before Phase 1 (2026-09-26)

These override the original build brief where they differ.

1. **Game rules flag, never reject.** The Postgres insert function checks only schema, role
   authority, duplicate IDs, and assigns `seq`. Game rules (5 on floor, rebound needs a miss,
   foul limits, ...) run in `core` on every client and reader and produce data-quality flags.
   Reason: in offline multi mode no single device sees both teams' events, so rejecting would
   lose real events on merge.
2. **Canonical order is `(period, gameClock desc, seq)`.** `seq` is arrival order, which puts
   late offline events at the end. Ties at a stopped clock fall back to `seq`, then `wallClock`,
   then `id` so the order is total and deterministic.
3. **Rebound prompts split by team in multi mode.** Shooting team's device offers
   offensive/team rebound; the defending device prompts for the defensive rebound.
4. **Follow-ups (assist, steal) are emitted first, amended after.** Nothing waits on a prompt.
5. **The app runs the game clock** from start/stop events (`wallClock` + server time offset).
6. **Fewer than 5 on floor is allowed and flagged** (FIBA plays on until 1 player).
7. **Public live feed** = Postgres insert trigger -> `realtime.broadcast_changes` on a separate
   viewer channel, plus a read-only RPC for first load.
8. **Dependencies:** valibot instead of zod (bundle size), `crypto.randomUUID()` instead of
   ULID (native; ordering comes from `seq`/`deviceSeq`), `idb` instead of Dexie.
9. Stat definitions follow the FIBA Statistics Manual. Supabase region is chosen later after
   measuring from Accra on MTN and Telecel.

## Phase 1: `packages/core`

### Step 0: workspace

- pnpm workspace (`packages/*`, `apps/*`), strict TypeScript base config with
  `noUncheckedIndexedAccess`.
- `core` has no build step: it exports `src/index.ts` directly; Vite and Vitest consume TS source.
- `core` compiles with `lib: ES2022` and `types: []` so no DOM or Node API can leak into pure code.
- Commands: `pnpm test` and `pnpm typecheck` from the repo root.

### Step 1: rule sets

- `rules.ts`: `RuleSetSchema` (valibot), `FIBA` and `NBA` presets, `periodLength`, `timeoutsAllowed`.
- Timeouts are modelled as windows: `{ periods: [1, 2], count: 2 }`. A period not in any window is
  overtime and gets `overtimeTimeouts` for itself alone.
- `teamFoulKinds` lists which player foul kinds count toward the team foul total. NBA excludes
  offensive and technical fouls. **Verify against the current NBA rulebook before relying on it.**
- `overtimeCarriesLastPeriod`: FIBA counts overtime team fouls as part of the 4th period.
- Not modelled (deliberately): FIBA's last-2-minutes timeout cap, NBA's 4th-quarter timeout limits
  and last-2-minutes bonus rule. Add if a league needs them.

### Step 2: event schemas

- `events.ts`: one valibot schema per event type. `EventSchema = Envelope ∩ Body`, where Body is
  a nested `variant` on `type` over three groups: play (game control, subs, shots, FTs, rebounds,
  turnovers, fouls), corrections (`amend`, `void`), session (role claim/release/transfer,
  `checkpoint`, `adminLock`).
- `parseEvent(input)` is the boundary check. Use it on everything from network, storage or import.
- Schema rejects only structural nonsense (assist on a miss, block on a make, x without y,
  attempt 3 of 2, coach "personal" foul). Anything that depends on game state is a flag (step 5).
- Choices worth knowing:
  - Shot and free throw have no `team`: it is derived from the shooter via the roster.
  - `gameStart` carries the rule set, both rosters and the shot-location setting, so the event log
    is self-contained for export and replay. A late roster addition = amend the `gameStart`.
  - Team rebound / team turnover = omit `player`.
  - A technical foul's free throws have no `fouled` player; the shooter is chosen at the line.
  - Shot `x`/`y` are normalised 0..1. The court mapping is decided with the shot chart (Phase 6).
  - `amend` replaces the target's whole body (type and payload), so a mis-typed event can be fixed
    in one correction. Only play events can be amended. Corrections and session events cannot.
- `test-helpers.ts` `ev()` builds events with defaults: every call advances `seq`, `deviceSeq`
  and counts `gameClock` down, so events built in order are already in canonical order.

### Step 3: reducer

- `reducer.ts`: `GameState`, `initialState`, `apply(state, event)`, `replay(log)`, `teamFoulCount`.
- `apply` is pure and incremental: one event in, new state out. It `structuredClone`s the ~1 KB
  state per event. Good enough (a 1000-event replay is milliseconds); swap for structural sharing
  only if profiling shows it. `core` declares `structuredClone` itself in `globals.d.ts` because it
  compiles without DOM/Node types.
- `replay` folds an **already ordered and resolved** log (ordering + corrections come in steps 4
  and 6). It skips duplicate ids.
- State kept is what validation and the scorer UI need: score, on-floor, personal fouls, team
  fouls per period, timeouts per period, the free-throw queue, `reboundable`, possession arrow,
  roles, clock, lock. Box-score stats are Phase 6 and will be derived from the log, not stored here.
- Free-throw queue: a foul with `freeThrows > 0` queues `{team, shooter, next, of}` for the fouled
  player (`shooter: null` for technicals = anyone on that team). FTs advance it; `periodEnd` clears it.
- Clock: the reducer only stores the last start/stop (`gameClock` + `wallClock`). The live running
  time is `gameClock - (now - wallClock)`, computed by the UI with the server-time offset.
- Only player fouls count toward team fouls, filtered by `rules.teamFoulKinds`. Coach/bench fouls
  don't count as personal fouls either. Coach technical limits (FIBA: 2 C or 3 B+C) are not
  modelled yet.
- Property tests use `arbGameLog` (random, structurally valid, not rule-valid logs). Gotcha: a
  fast-check property that returns a falsy value fails, so use block bodies around `expect`.
- Checked the duplicate-id property test by temporarily removing dedupe: it fails as it should.

### Step 4: canonical ordering and GameLog

- `log.ts`: `compareEvents` and `GameLog`.
- Order: `period` asc, `gameClock` desc, `seq` asc with unconfirmed (`null`) last, then `wallClock`,
  then `id`. The `id` tie-break makes it a total order, so every device converges on the same log.
- `GameLog` keeps the sorted events **and the state after each event**. `add(e)`:
  - duplicate id -> ignored (returns -1)
  - durable version (has `seq`) of an unconfirmed event -> replaces it ("durable wins")
  - stale unconfirmed copy of a durable event -> ignored
  - otherwise inserted at its sorted position; replay runs only from that index.
  - Returns the index replay started from. A normal tap appends and applies exactly one event,
    which satisfies "never replay the full log on a tap".
- Memory: one ~1 KB state per event; a 1000-event game is about 1 MB. Fine for now; keep
  checkpoints every N events instead if it ever matters.
- Insertion scans from the end because nearly every event lands at or near the end.
- Property test: any arrival permutation of a canonical log produces the identical log and state.

### Step 5: validation as flags

- `validate.ts`: `check(stateBefore, event) -> Flag[]`, `teamFoulCount`, `dataQuality`.
- `apply` calls `check` on every event and appends to `state.flags`. So validation runs wherever
  the reducer runs (client, server-side readers, export), and there is still only one implementation.
- Flag codes (`{ eventId, code, detail? }`):

  | code | when |
  |---|---|
  | `no-game-start` | play event before `gameStart` |
  | `unknown-player` / `wrong-team` / `not-on-floor` | player checks on every involved player |
  | `fouled-out` | player at the foul limit acts, is subbed in, or starts a period |
  | `lineup-size` | a team does not have exactly 5 after `periodStart` or a substitution |
  | `bad-substitution` | out-player not on floor, in-player already on floor or on the other team |
  | `rebound-without-miss` | no missed shot / missed last FT before it |
  | `unexpected-free-throw` / `free-throw-order` | FT no one is owed / wrong attempt number |
  | `free-throw-count` | foul's FT count doesn't match kind + bonus + rule set |
  | `free-throws-unfinished` | `periodEnd` with FTs still owed |
  | `timeouts-exceeded` | more than the window allows |
  | `role-held` | claim of a role another device holds (the claim is also not applied) |
  | `score-mismatch` | `checkpoint` differs from the computed score |
  | `missing-location` | shot without x/y when the game has shot locations on |
  | `locked-correction` | non-admin `amend`/`void` after `adminLock` |

- FT-count rules: personal = bonus FTs if the team was already at the threshold, else 0; offensive
  = 0; technical = `rules.technicalFreeThrows`; shooting/unsportsmanlike/disqualifying = at least 1.
- **Bug found by property test (fixed):** `arbGameLog` reset the clock to 10:00 in overtime
  instead of 5:00, so generated OT logs weren't canonical and the arrival-order property failed on
  rare runs. The fix was in the generator. `GameLog` was right. A 3000-run soak passes.

### Step 6: corrections

- Lives in `GameLog` (`log.ts`), not the reducer: corrections change *which* events the reducer
  sees, so they're resolved before folding.
- `GameLog.events` = each game event in its corrected form (amended body, or absent if voided),
  plus the `amend`/`void` events themselves as markers at the time they were made. The reducer
  treats markers as no-ops apart from the `locked-correction` flag.
- Per target, the winning correction is the latest by **write order**: `seq` (unconfirmed last),
  then `wallClock`, then `id`. So:
  - concurrent amends: higher `seq` wins whatever the arrival order;
  - a local unconfirmed amend shows immediately and wins until its durable copy arrives with a
    real `seq`;
  - a later amend can restore a voided event (void then amend = amend).
- `amend` replaces the whole body (type + payload) but keeps the envelope, so the event stays in
  its original position.
- A correction may arrive before its target (offline merge); it applies when the target arrives.
- Corrections aimed at corrections are ignored.
- Admin lock: after an `adminLock` (by write order) only `role: 'admin'` corrections apply. A lock
  arriving late re-resolves every corrected event.
- `correctionsFor(id)` returns the corrections in force for an event, winner last. Phase 5 uses it
  for the "your amendment was overridden" notification.
- Known gap: voiding an `adminLock` does not unlock. Unlocking should be an explicit admin action
  if it's ever needed.

## Phase 1 report

**Built:** `packages/core`: rule sets with FIBA and NBA presets, valibot schemas for every event
type, a pure incremental reducer, canonical ordering, `GameLog` with insertion-point replay,
validation as data-quality flags, and corrections with last-write-wins.

**Verified (132 tests, `pnpm test`; `pnpm typecheck` clean):**
- Schema accept/reject for every event type; rule set rejects bad values.
- Reducer unit tests per event type; a hand-built clean game raises zero flags; every section 10
  rule has a test that triggers its flag.
- Property tests (fast-check): replay determinism, duplicate-id idempotency, `apply` never mutates
  input, any arrival order converges to the same log and state (with and without corrections),
  void-then-replay equals never having the event. Soaked at 2000-3000 runs.
- Mutation checks: removing duplicate-id handling or the lock rule makes the matching tests fail.
- Timing (1000-event game, Node, dev laptop): append p50 0.018 ms, p99 0.045 ms; worst case
  (void of the first event, full replay) about 20 ms.

**Not verified / not built:**
- Timing on a throttled phone CPU (Phase 4 e2e). The 20 ms worst case is the `structuredClone`
  per event; structural sharing is the fix if phones are slow.
- NBA `teamFoulKinds` (offensive and technical excluded) is from memory. Check the rulebook.
- Not modelled: FIBA/NBA end-of-game timeout and bonus specials, coach technical limits,
  ownership/role authority (server-side, Phase 2), derived stats (Phase 6).
- Validation doesn't flag rebound kind vs team mismatch (e.g. "offensive" rebound by the defence).

## Phase 2: Supabase

### Step 1: local setup and event JSON Schema

- Supabase CLI is a root dev dependency (`pnpm exec supabase ...`). Runs on Rancher Desktop (dockerd).
- `supabase/config.toml`: anonymous sign-ins on; Studio, Storage, edge functions, analytics and the
  mail catcher off. Start with only what we use (images are big, the network is slow):

  ```
  pnpm exec supabase start -x postgres-meta,supavisor,imgproxy,vector,logflare,studio,mailpit,storage-api,edge-runtime
  pnpm exec supabase db reset   # re-apply migrations + seed
  pnpm exec supabase test db    # pgTAP tests in supabase/tests
  ```

- **Event validation on the server uses the same valibot schema as the client.**
  `@valibot/to-json-schema` turns `EventSchema` into JSON Schema; Postgres checks it with
  `pg_jsonschema`. The JSON lives in a generated migration (`*_event_schema.sql`, function
  `event_json_schema()`).
  - `packages/core/src/event-schema.test.ts` fails if the newest `*_event_schema.sql` doesn't match
    `EventSchema`. Fix: `pnpm --filter @stats/core db:event-schema`, which writes a **new** migration
    (migrations are immutable once applied).
  - Cross-field `v.check`s (assist only on a make, etc.) don't translate to JSON Schema; they stay
    client-side, and core flags or rejects them on parse.
  - The JSON Schema does not forbid unknown keys (valibot strips them on the client).

### Step 2: schema

- Tables: `leagues`, `league_admins`, `rule_sets` (core RuleSet as jsonb), `seasons`, `teams`,
  `players`, `games`, `game_roster`, `game_codes`, `game_scorers`, `role_claims`, `events`.
- No game state is stored. `games.last_seq` is the only counter.
- `games.public_slug` = 122 random bits (uuid without dashes) for public viewer links.
- `events` is append-only: triggers reject UPDATE, DELETE and TRUNCATE for everyone, including
  the owner. Consequence: a game with events can't be deleted. That's intended.
- RLS is enabled on every table from the start (test asserts it). Policies come in step 6.
- `supabase/seed.sql` holds **test helpers only** (schema `tests`): `create_user`, `login`,
  `as_anon`, `as_postgres`, `game_fixture`, `event`. Seeds never run on hosted projects.
  - `tests.login` sets `role` + `request.jwt.claims`, the same thing PostgREST does, so RLS and
    `auth.uid()` behave as they do for real requests.

### Step 3: insert_event

- `insert_event(event jsonb) -> seq`, the only way to write events. In order:
  1. JSON Schema check (`22023` on failure);
  2. `select ... for update` on the game row (serialises seq per game, other games unaffected);
  3. caller must be a scorer of the game or a league admin (`42501`);
  4. same event id already stored -> return its seq (outbox resends are safe; `23505` if the id
     belongs to another game);
  5. `authorize_event` (step 4);
  6. `last_seq + 1` -> insert.
- The client's `seq` is ignored; the server's is canonical.
- `event_json(row)` turns a row back into the core `GameEvent` shape (camelCase).
- Test 02 claims the `single` role first because it runs with step 4's authority rules.

### Step 4: role authority

- `authorize_event(game, event)` enforces brief sections 6 and 7:
  - `admin` role: league admins only; may write anything, including after the lock.
    `adminLock` sets `games.locked_at`.
  - After the lock, everything else is rejected.
  - `single` role only in single-mode games; `teamA`/`teamB`/`clock` only in multi mode.
  - `roleClaim`: the primary key on `role_claims` makes claims exclusive; a second claim -> `23505`.
  - Every other event: caller must hold `event.role`.
  - `roleRelease`: caller must hold the released role.
  - `roleTransfer`: **any role holder may move any role to any joined device.** This is how a dead
    device's role is taken over. It's an event, so it's auditable. Confirm in Phase 5.
  - `amend`, `void`, `checkpoint`: any scorer role.
  - Ownership: game control (incl. timeouts, jump balls) -> `clock` if claimed, else `teamA`;
    substitution/rebound/turnover/foul -> `team<payload.team>`; shot/free throw -> team of the
    shooter from `game_roster`.
- Known edges:
  - A shooter not in `game_roster` (added late via a `gameStart` amend) can't be attributed, so any
    team role may write it. core still flags it.
  - **Offline outbox after a role transfer:** events recorded offline while holding a role are
    rejected if the role moved before they were flushed. Phase 3 must keep rejected events visible
    (not silently dropped) for an admin to re-enter.

### Step 5: game codes

- `create_game_code(game, valid_for = 1 day)`: admins only. 8 characters from a 32-letter
  alphabet with no 0/O/1/I (~10^12 codes), so there's no attempt limiter.
- `join_game(code, device_id) -> game_id`: after `signInAnonymously()`. Rejects unknown, expired,
  revoked codes and locked games. Case-insensitive. Re-joining updates the device id.
- `revoke_game_code(code)`: marks it revoked, removes every scorer who joined with it and their
  role claims.
- Local auth allows 30 anonymous sign-ins per hour per IP (config.toml). Fine for one venue.

### Verification note (steps 2-5)

Steps 2-5 were written while the images pulled and first run together (47 pgTAP tests).
Failures on the first run were test-helper bugs (`tests.login` reading `auth.users` as
`authenticated`; test 02 predating role claims; a missing `::text` cast), not migration bugs.
All 47 pass.

### Step 6: RLS

- League admins: full access to their league's rows (leagues, admins, rule sets, seasons, teams,
  players, games, rosters). They can read codes, scorers, roles and events.
- Scorers (anonymous users in `game_scorers`): read-only access to their game, its roster, rule
  set, team and player names, role claims and events. Nothing else.
- Nobody inserts into `events`, `game_codes`, `game_scorers` or `role_claims` directly: those go
  through `insert_event`, `create_game_code`, `join_game`, `revoke_game_code`.
- `create_league(name)`: any non-anonymous account; the creator becomes admin. It's a function
  rather than an insert policy + trigger because `insert ... returning` would fail RLS before the
  trigger made the creator an admin.
- `game_events(game, after_seq)`: reconnect catch-up in core JSON shape, under RLS.
- `anon` still has Supabase's default table grants; RLS hides every row (tested). Public viewers
  use the slug functions in step 7.
- **Bug caught by tests:** unqualified `id` inside a policy subquery bound to the subquery's table
  (`games.id`) instead of the policy's table. Always qualify (`teams.id`) in policy subqueries.

### Step 7: broadcast and public read

- After-insert trigger on `events` calls `realtime.send` with the core-shaped event on two
  **private** channels:
  - `game:<gameId>` for scorers and admins: they can read (durable confirmations, with `seq`) and
    send (the client fast path in Phase 3).
  - `view:<slug>` for public viewers: read-only, for anyone (including `anon`) who knows an existing
    slug. It's private rather than public because on a public Realtime channel any client can
    send, so a viewer could inject fake events for other viewers.
- Channel authorization = RLS policies on `realtime.messages` using `realtime.topic()`.
- `public_game(slug)` (teams, rules, roster names, lock) and `public_events(slug, after_seq)` for
  viewers' first load and catch-up. Viewers have no table access.
- Not batched for viewers (decision 7). Revisit if viewer counts grow.
- Clients must subscribe with `{ config: { private: true } }`, after `supabase.realtime.setAuth()`
  for signed-in scorers.

## Phase 2 report

**Built:** Supabase schema (12 tables, append-only `events`), generated event JSON Schema enforced
with `pg_jsonschema`, `insert_event` (schema, membership, idempotent resend, role authority,
ownership, lock, atomic per-game `seq`), game codes (create/join/revoke), RLS on every table,
broadcast trigger with private scorer and viewer channels, public slug functions, local dev setup.

**Verified:**
- 81 pgTAP tests (`pnpm exec supabase test db`) against local Supabase on Rancher, covering
  append-only, seq, idempotency, schema rejection, every ownership rule, exclusive claims,
  transfer, lock, codes, RLS per role (admin, scorer, outsider, anon, account), broadcast topics
  and payloads, channel authorization.
- 133 core tests, including the schema-drift test.
- End-to-end smoke with supabase-js against the running stack (script kept out of the repo):
  anonymous sign-in -> `join_game` -> private channel subscribe (outsider refused by the real
  Realtime server) -> `insert_event` -> both scorer and viewer channels receive the durable event.
  Locally: RPC ~10 ms, broadcast received ~10 ms after the call.

**Not verified / open:**
- Concurrency of seq assignment under parallel writers is by design (row lock) but not
  load-tested. Phase 3's multi-client sync tests should hammer it.
- No hosted project yet; region still to be chosen from Accra measurements (MTN, Telecel).
- Open decisions for Phase 5: role transfer by any role holder; offline events rejected after a
  role moved.
- JSON Schema can't express valibot's cross-field checks; those remain client-side.

### Hosted project

- Project `StatsTracker`, ref `uulqbabkuqgumljonupy`, region **eu-west-2 (London)**. Chosen
  before measuring from Accra; the project is still near-empty, so recreating elsewhere is cheap
  if MTN/Telecel measurements favour another region.
- Linked with `pnpm exec supabase link --project-ref uulqbabkuqgumljonupy` (run in a real
  terminal: login and link are interactive; keep the token and DB password out of the repo).
- All 7 migrations pushed with `pnpm exec supabase db push` (2026-09-26). `seed.sql` is never
  pushed: it only holds local pgTAP helpers.
- Checked live with the anon key: `public_game` answers anon (null for an unknown slug), `events`
  returns no rows to anon, `insert_event` is refused for anon.
- **Manual setting:** anonymous sign-ins are enabled in the dashboard (Authentication -> Sign In /
  Providers). `config.toml` auth settings do not sync automatically.
- Deploying schema changes: new migration -> `pnpm exec supabase db push`.

## Phase 3: `packages/sync`

Assumptions stated at the start of the phase:
- A server-rejected event that was already fast-path broadcast is pulled back: the writer
  broadcasts `discard`, and peers drop it if it's still unconfirmed. The writer keeps it in its
  local store marked rejected, for admin review. The durable log is never affected.
- Peer broadcasts are untrusted input and pass through `parseEvent`.
- `@supabase/supabase-js` is a type-level/dev dependency of `sync`. The scorer app creates the
  client, so the bundle-size choice (full supabase-js vs. its sub-packages) is made and measured
  in Phase 4.

### Step 1: SyncTransport and the simulated network

- `transport.ts`: the one required abstraction. `connect(handlers)`, `broadcast(message)`
  (fast path, fire-and-forget), `persist(event) -> seq` (durable), `fetchSince(seq)`,
  `serverTime()`, `close()`. Errors: `Rejected` (don't retry) vs `NetworkError` (retry; resends
  are idempotent).
- Peer messages: `{kind: 'event'}` or `{kind: 'discard', eventId}`.
- `sim.ts`: `SimNetwork` + `SimTransport`, a deterministic in-memory backend: seeded PRNG,
  virtual time, per-message latency range, drop and duplicate probability, lost acks (server
  applied, response lost), per-client online/offline, and a `rejectIf` hook for authority
  rejections. `await net.settle()` runs virtual time until quiet.
- Gotcha: a promise that rejects inside `settle()` before a handler is attached shows up as an
  unhandled rejection in Vitest. Capture with `.catch(e => e)` before settling.

### Step 2: LocalStore

- `store.ts`: IndexedDB via `idb` (~1 KB). One object store `events`, keyed by `event.id`,
  indexed by `event.gameId`, holding `{ event, rejected? }`.
- It holds **every** event the device knows for the game, its own and peers', so a reload
  mid-game while offline rebuilds full state. The outbox is not a separate store: it's this
  device's events with `seq === null` and no `rejected`.
- `put` follows the same rule as `GameLog`: a durable copy is never overwritten by an
  unconfirmed one. `put(e, reason)` marks an event rejected; it stays for admin review.
- Tests use `fake-indexeddb` (dev only), including 200 un-awaited writes landing in order.
- Requesting persistent storage (`navigator.storage.persist()`) is the app's job (Phase 4).

### Step 3: GameSync

- `game-sync.ts`: one game on one device. `GameSync.open({gameId, deviceId, transport, store})`
  loads everything stored for the game into a `GameLog` (so offline reloads work), rebuilds the
  outbox (own `seq: null` events, in `deviceSeq` order) and connects.
- `record(e)`, the tap path, in this order:
  1. `log.add(e)` + `onChange()` (render; synchronous);
  2. `store.put(e)` (not awaited);
  3. push to outbox, fast-path `broadcast`;
  4. `flush()` (durable path, async).
- `flush()` sends the outbox **one event at a time, in order**. On success it applies the durable
  copy. On `Rejected` it drops the event from the outbox, marks it rejected in the store, discards
  it from the log, broadcasts `discard` to peers and calls `onRejected`. On `NetworkError` it stops
  and retries after `retryMs`, or sooner on the next `online` / tap.
- A durable copy of our own event from any source (RPC reply, server broadcast, catch-up)
  confirms it and removes it from the outbox. That covers the lost-ack case.
- Incoming events are untrusted: `parseEvent`, then ignore other games.
- `nextDeviceSeq()`: highest own `deviceSeq` seen (including stored and rejected) + 1.
- `now()`: local clock + `clockOffset`, measured on every reconnect from one `serverTime()` round
  trip (midpoint). The UI should use it for `wallClock` and the running game clock.
- Timers are injectable (`setTimer`) so simulated tests run retries in virtual time.
- core gained `GameLog.get(id)` and `GameLog.discard(id)`. `discard` refuses durable events; the
  durable log stays append-only.
- Mutation-checked: removing "durable copy confirms pending" or the `discard` broadcast fails tests.

### Step 4: reconnect, gaps and convergence

- Catch-up (`fetchSince(contiguous)`) runs:
  1. on every `online` status (reconnect);
  2. immediately when a durable event arrives with a seq beyond `contiguous + 1` (a gap);
  3. on a **poll every `pollMs` (10 s)**. Found while designing the property test: if the *last*
     durable broadcast is lost, no later seq reveals the gap. Over a WebSocket that mostly
     happens around reconnects (already covered), but the poll makes it certain. One small RPC
     per 10 s per device.
- `contiguous` = highest seq such that every seq up to it has been received.
- Simulator additions: `step(n)` to observe in-flight states; idle tasks (poll timers) don't hold
  `settle()` open; `advance(ms)` runs virtual time including them. `setTimer` receives a
  `kind` ('retry' | 'poll') so tests can tell them apart.
- **Property test (`convergence.test.ts`)**: 2 and 3 clients, random taps (shots, timeouts,
  rebounds, amends, voids of random known events), random online/offline toggles and waits,
  random network (latency 1-40, drop <= 40%, duplicate <= 30%, lost ack <= 30%). After healing,
  every client's log and state equal the log built from the server, and every tap is on the
  server exactly once. 60 runs each in CI; soaked at 500 each.
- Mutation-checked: disabling the poll, or catch-up on reconnect, fails their targeted tests.
  Silently dropping an outbox event on a network error fails both convergence properties.
- Speed: the simulator yields with `setImmediate` where available. `setTimeout(0)` is clamped to
  >= 1 ms and made the suite take 172 s instead of under 1 s.

### Step 5: concurrent amendments

- Last-write-wins comes from core (`GameLog`, by server `seq`; an unconfirmed local correction
  ranks last until confirmed). `GameSync` adds the notification.
- `onConflict(targetId, corrections)` fires when corrections from **two or more devices** compete
  for one event, **once when the conflict appears and again only if the winner changes** (e.g.
  when confirmations reorder an unconfirmed local amend). Confirmations that don't change the
  winner don't re-notify. A device correcting its own work never notifies.
- `corrections` is oldest-first; the last one is the winner. The UI (Phase 5) shows "X changed
  this to Y".
- Checked on both the tap path (`record`) and the receive path.
- Tests: two scorers amend the same shot concurrently; both converge on the higher-seq amend and
  both are notified with it as winner; no notification for single-device corrections; no repeat
  notifications from confirmations.

### Step 6: SupabaseTransport

- `supabase.ts`: `SupabaseTransport(client, gameId)`.
  - Fast path: `channel('game:<id>', { private: true, broadcast: { self: false } })`, events
    `event` and `discard`. Status: `SUBSCRIBED` -> online, anything else -> offline (realtime-js
    rejoins by itself, and the next `SUBSCRIBED` triggers catch-up + flush).
  - Durable: `rpc('insert_event')`. Catch-up: `rpc('game_events')`, paged in 1000s (PostgREST's
    default row cap). Clock: `rpc('server_now')` (new migration `20260927090000_server_now`).
  - Error classification: HTTP 4xx except 401/408/429 -> `Rejected` (keeps the Postgres code);
    everything else (no response, 5xx, expired token) -> `NetworkError` (retry).
- `supabaseClientOptions` = `{ realtime: { heartbeatIntervalMs: 5000 } }`: pass to `createClient`
  on scorer devices (brief: heartbeat every few seconds keeps cellular radios awake).
- `GameSync.onPeerLatency(eventId, ms)`: tap-to-receipt for a peer's fast-path event, computed
  as `now() - event.wallClock`. Both clocks are server-corrected, so the UI must stamp
  `wallClock` with `sync.now()`. Storing and showing samples is Phase 7.
- **Integration test** (`supabase.integration.test.ts`, runs in `pnpm test`, skips with a
  visible warning if local Supabase is down): real admin account, league, teams, players, game,
  code; two anonymous scorers join and claim teamA/teamB; record through `GameSync`; both
  converge; a teamA device writing a teamB shot is rejected by the real server and pulled back
  from B; a third device joining late catches up; `public_events` by slug matches. Local: peer
  fast-path latency 1-5 ms, clock offset < 1 s.
- Event stamping note: pregame session events (role claims) should use period 0 so they sort
  before `gameStart` in canonical order. Phase 4's event builder does this.

## Phase 3 report

**Built:** `packages/sync`: `SyncTransport` (the one abstraction), `SupabaseTransport`,
IndexedDB `LocalStore` (log + outbox + rejected), `GameSync` (tap path, ordered durable flush,
confirmations, rejection pull-back, catch-up on reconnect / gap / 10 s poll, server clock offset,
conflict notifications, peer latency hook), deterministic network simulator. Core gained
`GameLog.get` and `GameLog.discard` (unconfirmed only). Supabase gained `server_now()`.

**Verified (`pnpm test`: core 137, sync 46; `supabase test db`: 83):**
- Simulator self-tests; LocalStore semantics on fake IndexedDB.
- GameSync: synchronous local apply, outbox ordering, offline reload, lost acks, rejection
  pull-back on all devices, untrusted input ignored.
- Property tests: 2 and 3 clients under latency, drops, duplicates, lost acks and outages always
  converge to the server log, with every tap stored exactly once (60 runs each; soaked at 500).
- Concurrent amendments: last write wins by seq on every device; both scorers notified; no
  repeat notifications.
- Mutation checks on confirmation, discard, poll, reconnect catch-up and outbox loss.
- Live integration against local Supabase: two and three real clients, real RLS/authority
  rejection, Realtime private channels, catch-up, public read.

**Not verified / open:**
- Nothing measured over a real cellular network yet. Local latencies say nothing about Accra ->
  London.
- `server_now` migration not yet pushed to the hosted project.
- Behaviour when the anonymous session's token expires mid-game relies on supabase-js
  auto-refresh; classified as retryable, but not exercised.
- Bundle size of supabase-js is measured in Phase 4.

## Phase 4: scorer app, single mode

### Step 1: scaffold

- `apps/scorer`: Preact + @preact/signals + Vite 8, strict TS. `pnpm --filter @stats/scorer dev`.
- Env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` in `apps/scorer/.env.local` (gitignored).
  Defaults to local Supabase.
- `public/sw.js`: hand-written service worker (no plugin): network-first for navigations (updates
  land when online, cached shell when offline), cache-first for hashed assets, and nothing
  cross-origin (Supabase traffic is never cached). `manifest.webmanifest` + SVG icon make it
  installable.
- `pnpm dev:game [--multi]` (root, `scripts/dev-game.ts`, run with `tsx`): demo league, two
  teams of 12 with jerseys 4-15, FIBA rules, shot locations on, a game and a join code. Local by
  default; set `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_KEY` for hosted. Stand-in
  for Phase 7 admin.
- Playwright + Chromium installed for e2e.
- **Bundle decision (measured):** full `@supabase/supabase-js` = 59.8 KB gzip with Preact;
  auth-js + postgrest-js + realtime-js alone = 48.5 KB. Kept full supabase-js: ~11 KB only on
  first load (the service worker caches after), and hand-wiring auth tokens into PostgREST and
  Realtime is where token-refresh bugs would live. Revisit if first-load time on 3G matters.

### Step 2: entry logic (pure, tested)

- `apps/scorer/src/logic/entry.ts`: the two-tap state machine. `step(entry, input, ctx)` ->
  `{ entry, events }`. `ctx` = current `GameState`, the effective log and `stamp(body)` (wraps
  an `EventBody` in an envelope). No UI, fully unit-tested (35 tests).
  - Player first, then action. Prompts after actions: assist (made shot), rebound (missed shot /
    missed last FT), turnover kind then steal (turnover), foul kind -> fouled player -> FT count
    (shooting/unsportsmanlike/disqualifying). **Prompts never block**: a tap that isn't an
    answer skips the prompt and starts a new selection. Only the substitution is modal (confirm or skip).
  - Rebound kind is derived: same team as the last shooter = offensive.
  - Personal-foul free throws come from the team-foul bonus (core `teamFoulCount` + rule set).
    Technical = `rules.technicalFreeThrows`, no fouled player; the shooter is picked at the line.
  - Offensive foul also records a turnover (`offensiveFoul`) for the same player (FIBA counting).
  - Block / steal / late assist: defender (or teammate) first, then BLK / STL / AST, which amends
    the last matching shot or turnover.
  - Assist and steal prompts amend the event just recorded (decision 4: emit first, amend after).
  - Court tap -> `shotValue(x, y)` suggests 2 or 3 from FIBA lines (`court.ts`); the scorer can
    flip it before Made/Miss. The four plain shot buttons work with or without location.
- `logic/undo.ts`: `undoLast(log, deviceId, undone)` -> `{ undoes, body }`. Voids my last
  non-session event. If that event is itself a correction, it restores what the correction
  replaced (core ignores corrections of corrections). The app keeps `undone` (undone ids + undo
  markers) so repeated undo walks back.
- `logic/clock.ts`: running time from the reducer's last start/stop; `10:00` format, tenths in
  the last minute.
- core: new `EventBody` type (any event's `{type, payload}` without the envelope).

### Step 3: the app (join, pre-game, live scoring, play-by-play)

- `session.ts`: Supabase client, join (anonymous sign-in -> `join_game` -> load game info),
  resume, `GameSync` wiring, and the signals the UI reads (`state`, `events`, `entry`,
  `online`, `pending`, `rejected`, `notice`, `now`, `tapToRender`). Game info (teams, roster
  names/jerseys, rules, mode) is cached in `localStorage`, together with the Supabase session and
  a per-device id, so a reload mid-game **while offline** goes straight back into the game.
- `stamp()` builds envelopes: pregame events use period 0; `gameClock` is the running clock,
  **rounded** (see bug below); `deviceSeq` and `wallClock` strictly increase, so two events from
  one tap (offensive foul + turnover) keep their order.
- Single mode: the device claims the `single` role on open if it doesn't hold it.
- `app.tsx`:
  - Join -> Pregame (pick 5+5 starters; Start = `gameStart` + `periodStart`) -> Live.
  - Live: scoreboard (score, team fouls with BONUS, timeouts left, clock tap = start/stop, "set"
    to match the official clock, online/offline + "N to sync"), two team panels (on-floor players
    always visible; the whole roster during a sub), centre action pad driven by the entry
    machine, free-throw bar while FTs are owed, Undo / End period / Play-by-play.
  - Break: score check against the official scoreboard (`checkpoint`; a mismatch warns and is
    flagged), then next period / overtime / end game.
  - Play-by-play: tap a row to Remove (void) or, for shots and FTs, flip made/missed or 2/3
    (amend). Server-refused events are listed separately with the reason.
- Fine-grained rendering: each player button and score reads its own computed signal; team
  panels only re-render when their lineup string changes.
- All inputs fire on `pointerdown`; `touch-action: manipulation` on buttons and the court.
- Layouts: tablet/laptop = teams left and right of the pad; phone (<= 720 px) = teams side by side
  above the pad. An e2e test asserts the phone layout needs no scrolling (390x844).
- Build: 80 KB gzip JS + 1.6 KB CSS for the whole app.
- **Bug found by e2e (fixed):** while the clock ran, `gameClock` came out fractional (the clock
  offset is a midpoint, so /2), which the schema rejects. The server refused the events, and the
  app correctly pulled them back and listed them as refused. Fixes: round in `stamp`, and
  `GameSync.record` now validates the event with `parseEvent` and throws, so a UI bug fails
  loudly on the device instead of as a server rejection (~0.1 ms per tap).
- `SupabaseTransport.broadcast` skips when the channel isn't joined yet (the durable path
  delivers the event anyway); before, realtime-js fell back to one REST call per event.
- e2e (`apps/scorer/e2e`, Playwright against the production build + local Supabase; each test
  creates its own game): full single-mode sequence ending with every event on the server;
  play-by-play corrections; phone no-scroll.
