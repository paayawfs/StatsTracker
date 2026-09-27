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

### Step 4: keyboard shortcuts

- `logic/keys.ts` (pure, tested): `keyCommand(key, entry)` maps a key to an entry input or a
  command, depending on the current step; `resolveJersey` turns typed digits into a player
  (on-floor only, or the whole roster during a sub); `promptTeam` picks the team a jersey most
  likely means in the current prompt (fouled player / stealer = other team, passer = shooter's
  team, sub = subbing team).
- Map (also shown with `?`): digits + Enter or a 400 ms pause = player, Tab = same jersey on the
  other team; S/X 2 made/missed, D/C 3 made/missed; R V L B = rebound, assist, steal, block;
  T/F/U = turnover/foul/sub; M/N = FT made/missed; letters inside the foul and turnover pickers
  pick the type; 1-3 in the FT-count picker; Shift+A/B team rebound; Space clock; Z undo;
  Esc skip/cancel; Enter confirm.
- Keys are ignored while typing in an input, and with Ctrl/Cmd/Alt held.
- Honesty note: `keys.ts` and its first tests were written in one pass rather than strictly
  test-first; the follow-up fixes (Tab precedence in the shot-result step, `promptTeam`) were
  test-first.
- e2e: a sequence entered only from the keyboard (clock, shot + assist, shared-jersey Tab, foul ->
  FTs, undo, help overlay).

### Step 5: offline and latency

- **Service worker bug found by e2e (fixed), two parts:**
  1. On a first visit the page's own JS/CSS load before the worker controls the page, so
     runtime caching never saw them and an offline reload came up blank. The install step now
     fetches `/`, extracts `/assets/...` URLs and pre-caches them.
  2. Vite tags assets `crossorigin`, so requests carry `Origin`; the server answers
     `Vary: Origin`; the pre-cached copies (fetched without `Origin`) didn't match. Cache lookups
     use `ignoreVary: true` (same-origin, content-hashed files).
  - The first version of the offline test visited the page twice, which hid both bugs. It now
    does a single visit, like a real scorer.
- e2e `offline.spec.ts`: one visit -> join -> network off -> score (UI shows "offline", "2 to
  sync") -> **reload with no network** (the worker serves the app; IndexedDB + the cached
  session restore the game) -> network on -> the outbox drains and the server has both shots.
- e2e `latency.spec.ts`: CPU throttled 4x via CDP, 45 taps, reads the app's own tap-to-render
  samples (`window.__scorer`). Last run: median 12 ms, **p95 41 ms**, max 55 ms. Asserts p95 < 50.
- Known ceiling: old hashed assets stay in the cache after deploys (the cache name is fixed). Bump
  `CACHE` in `sw.js` to clear, or prune on activate if it matters.

## Phase 4 report

**Built:** `apps/scorer`, an installable PWA for single-mode scoring: join by code (anonymous
sign-in), pre-game starters, live scoring (two-tap entry with assist/rebound/steal prompts, fouls
with automatic bonus free throws and FT queue, multi-player subs, team actions, clock with
start/stop and set, undo), period-end score check, play-by-play corrections, refused-event list,
conflict notices, phone/tablet/laptop layouts, full keyboard map, offline with reload, wake lock,
persistent-storage request, tap-to-render instrumentation. `pnpm dev:game` creates demo games.

**Verified:**
- Unit: core 137, sync 47, scorer 61 (entry machine 35, keys 12, undo, clock, court).
- e2e (Playwright, production build, local Supabase), 6 tests: full single-mode sequence ending
  with all events on the server; play-by-play corrections; phone fits one screen; keyboard-only
  sequence; offline scoring + offline reload + reconnect sync; tap-to-render p95 < 50 ms at 4x
  CPU throttle.
- Screens checked by eye on tablet (1180x820) and phone (390x844).

**Not verified / open:**
- No real phone or real cellular network yet. The latency number is desktop Chrome with a
  throttled CPU, not a mid-range Android.
- Latency samples are only in memory; storing them per game and the admin dashboard are Phase 7.
- The amend editor is minimal (made/missed, 2/3 for shots and FTs; everything else is
  remove-and-re-enter).
- NBA court lines aren't modelled; the scorer flips 2/3 manually.
- If the browser loses the anonymous Supabase session (storage cleared), rejoining creates a new
  user, and the `single` role is still held by the old one. Fix in Phase 5 with role transfer.

## Phase 5: multi mode

Decisions (2026-09-27): **any joined scorer may take over a role** (covers a replacement device
that holds no role); **the game-control device picks both lineups** (Clock, else Team A).

### Step 1: take-over by any joined scorer (server)

- Migration `20260927120000_takeover_by_any_scorer`: in `authorize_event`, the `roleTransfer`
  branch now runs **before** the "caller must hold `event.role`" check. A transfer must be
  written with `event.role` = the transferred role. Membership is still required
  (`insert_event` checks it), the target device must have joined, and the lock still applies.
- The same path fixes the Phase 4 edge where a device that lost its session couldn't reclaim
  `single`: it takes it over.
- pgTAP: a device with no role takes over teamB, then writes as teamB; the old teamB device is
  refused. 86 tests.

### Step 2: ownership on the device

- `logic/ownership.ts` (pure, tested): `ownerRole(body, state)` mirrors `authorize_event`
  (game control -> clock if claimed else teamA; sub/rebound/turnover/foul -> payload team;
  shot/FT -> shooter's team; corrections/checkpoints/unknown shooter -> any role).
  `heldRoles`, `roleFor(body, state, device)` (the role to stamp, or null) and
  `capabilities(state, device)` -> `{ team(t), control }`. The server stays authoritative; this
  just stops the UI offering actions the server would refuse.
- Entry machine: optional `ctx.can`. Primary actions (shot, court, rebound, turnover, foul,
  sub) need the selected player's team; the rebound prompt accepts only owned teams (so the
  shooting team's device records only offensive/team rebounds, decision 3); FTs need the
  shooting team; timeout needs game control; team TO and coach/bench fouls need that team.
  Secondary players (fouled opponent, steal, block, assist amends) still work. Without `can`,
  everything is allowed (single mode unchanged).
- **Test-harness bug found (fixed):** Vitest in `apps/scorer` was also collecting the
  Playwright `e2e/*.spec.ts` files, and failing them at file level. Since Phase 4 step 3 the
  scorer's `pnpm test` had exited non-zero, and my grep for "Tests" hid it; the unit tests
  themselves passed. `vite.config.ts` now limits Vitest to `src/**/*.test.ts`.

### Step 3: multi mode in the app

- Session: `myRoles` / `can` (computed from the reducer's `roles` and this device id), `claim`,
  `takeOver` (a `roleTransfer` to this device, written as that role), `release`, `roleName`.
  Every event is stamped with the held role that owns it (`roleFor`). The entry machine gets
  `can`. Clock, set-clock and end-period are control-only (keyboard Space included).
- Peer-triggered prompts (`onPeerEvent`): when another device records a miss (missed shot, or
  a missed last FT) by the team this device doesn't own, and this device owns the defending
  team and is idle, it gets the rebound prompt (decision 3). A rebound or other play from
  elsewhere clears a pending rebound prompt.
- Notices: "Your X role was taken over by another device" / "You now hold X"; conflicts and
  refusals as before.
- UI:
  - Multi-mode devices with no role see the role picker (holder per role: you / another device /
    free; Claim, Take over, Release). Take over is only enabled while the clock is stopped
    (brief: transfers at stoppages). A Roles button stays in the footer during the game.
  - Pregame: only the game-control device (Clock, else Team A) picks starters; others wait.
  - Control bar (game-control device only): timeouts for both teams, possession arrow,
    jump ball (records `jumpBall` + arrow to the other team). Timeouts moved out of the team
    panels.
  - Team panels show Team TO / Coach T / Bench T / Team REB only for owned teams. Selecting an
    opponent offers just BLK / STL / AST. The FT bar has buttons only on the shooting team's
    device. Period breaks are driven by the control device.
- `window.__scorer.peerLatency` exposes fast-path receipt samples for e2e.
- The phone no-scroll e2e caught the new control bar pushing the page to 873 px; team actions
  now sit three to a row on phones.

### Step 4: multi-device e2e

- `e2e/multi-mode.spec.ts`: each "device" is its own browser context (own storage, own anonymous
  user, own device id). Fixture `device(browser, code, role)` joins and claims.
  1. Three devices (Team A, Team B, Clock): only Clock can start the game and run the clock; A's
     miss prompts B for the defensive rebound, and B's answer clears A's prompt; B's shooting
     foul puts the FT buttons on A's device only; A selecting a B player gets only BLK/STL/AST;
     timeouts only on the Clock device; peer fast-path latency under 300 ms (local: 2-6 ms);
     all durable, nothing refused.
  2. A held role shows "another device" and offers no Claim.
  3. Dead device: A's context is closed; B takes over teamA at a stoppage, records A's shot and
     runs the clock (multi -> single fallback); the server accepts everything.
  4. Concurrent amendments from two devices on the same shot: both see the conflict notice and
     end on the same score.
  5. Team B offline records a shot while A records one; after reconnect both devices show both.
- Full e2e: 11 passing (6 single-mode + 5 multi-mode).

## Phase 5 report

**Built:** multi mode end to end: role picker (claim / take over at a stoppage / release),
any-joined-scorer take-over on the server, per-event role stamping, device-side ownership
mirroring the server rules, split rebound prompts (decision 3), FT bar on the shooting team's
device, Clock device with control bar (timeouts, arrow, jump ball), control-only clock and period
actions, cross-device notices (role taken over / gained, conflicts, refusals).

**Verified:** unit core 137, sync 47, scorer 82; pgTAP 86; e2e 11 (5 multi-device). Local peer
fast-path latency 2-6 ms.

**Not verified / open:**
- The server-side refusal of a *simultaneous* double claim is covered by pgTAP (primary key);
  the e2e only covers the UI not offering a held role.
- Ownership rules live in two places (SQL `authorize_event` and `logic/ownership.ts`); both have
  tests for the same cases, but a change must be made in both.
- The take-over migration is not yet pushed to the hosted project.
- Offline events recorded by a device whose role was taken over meanwhile are refused on
  reconnect and shown in its refused list; re-entering them is manual (admin tooling, Phase 7).
- No real phones yet.

## Phase 6: derived stats and public app

Decisions (2026-09-27): lineups and on/off show raw totals plus +/- per 40 minutes (no
possession estimates); the box score includes FIBA efficiency (EFF).

### Step 1: walk + box score (core)

- `stats/walk.ts`: `walk(events)` replays an effective, canonically ordered log (e.g.
  `GameLog.events`) and yields `{ event, before, after, elapsed }`. `elapsed` = game time since
  the previous event in the same period, played by `before.onFloor`. Every derived stat is a fold
  over this.
- **Minutes come from event game clocks only**: time between two events belongs to the lineup
  before the second one; a stopped clock adds 0. No clock start/stop modelling needed. Mid-game,
  minutes run up to the latest event.
- `stats/box.ts`: `boxScore(events)` -> player lines (MIN, PTS, FGM-A, 2PM-A, 3PM-A, FTM-A,
  OREB, DREB, REB, AST, TO, STL, BLK, PF, FD, +/-, EFF) for every roster player in roster order,
  and team lines (totals + `teamReb`, `teamTo` inside REB/TO, `benchFouls` for coach/bench
  fouls, not in PF). Points come from the reducer's score change, so custom point values
  work.
- +/- credits each score to the lineup on the floor **at that event**, so a sub between free
  throws is handled (fixture checks it).
- Tests: a hand-verified fixture game (every number worked out by hand in the test comment) +
  properties on random logs (team points = scoreboard = sum of player points; team REB/TO = player
  sums + team-only).

### Step 2: lineups and on/off (core)

- `stats/lineups.ts`: `lineups(events)` -> per team, every unit (sorted player ids) with minutes,
  points for/against, +/- and +/- per 40 minutes, most minutes first. `onOff(events)` -> per
  roster player, the same split with the player on the floor and off it (off = team totals - on).
  `per40` is null with no minutes.
- Scores are credited to the unit on the floor at the scoring event (same rule as box +/-).
- The fixture game moved to `stats/fixture.ts`, shared by the box and lineup tests.
- Tests: exact units and on/off splits for the fixture; properties on random logs (per team,
  lineup minutes = time played and lineup +/- sum = score margin; per player, on + off = whole
  game).

### Step 3: shot chart and play-by-play (core)

- Court geometry moved from the scorer into core (`court.ts`): `shotValue` plus new
  `shotZone(x, y)` -> `paint` (inside the 4.9 m key, up to the FT line) / `midRange` /
  `corner3` / `aboveBreak3`.
- `stats/shots.ts`: `shotChart(events)` -> located shots (team, zone, made, period, clock) and
  made/attempted per zone per team. Shots without x/y are not charted (they still count in
  the box score).
- `stats/pbp.ts`: `describe(event, who)` (moved from the scorer; `who(id)` formats names, so
  each app picks its style) and `playByPlay(events, who)` -> viewer rows with the running
  score and the team that scored. It hides bookkeeping (role events, corrections, clock
  start/stop, checkpoints, arrow).
- The scorer now uses core's `shotValue` and `describe`, so there's one copy of each. Scorer e2e
  (11) still passes.

### Step 4: public viewer app

- `apps/public` (Preact + signals, 77 KB gzip): `/g/<slug>` -> live scoreboard (score, clock,
  period, LIVE / reconnecting / FINAL) and tabs: Box score (both teams, all roster players,
  team totals with shooting %), Play-by-play (newest first, running score, scoring rows marked),
  Lineups, On/Off (+/- per 40 difference), Shot chart (when the game has locations: SVG court,
  made dots / missed crosses per team, zone table). Phone-first; tables scroll sideways with the
  name column pinned.
- **Viewers reuse `GameSync`** with a new read-only `SupabaseViewerTransport` (sync package):
  `view:<slug>` private channel, `public_events` catch-up, `persist` always refused, never
  broadcasts. Viewers therefore get the tested gap detection, reconnect catch-up and IndexedDB
  cache. Poll every 30 s (not 10 s) to spare the server when many are watching.
- Stats are computed lazily per tab (`computed` signals read only by the visible tab).
- `vercel.json` rewrites `/g/*` to `index.html` for static hosting.
- `format.ts` (+ tests): `m:ss` minutes, shooting %, signed +/-.
- `clock.ts` (running game time, formatting) moved from the scorer into core, shared by both apps.
- **Bug found by the viewer e2e (fixed in both apps):** `GameLog.events` is one array mutated in
  place; assigning it to a signal again is a no-op, so computed stats (box score) never
  recomputed. Both apps now hand the signal `events.slice()`. The scorer only hid this because
  other state changes re-rendered its play-by-play.
- e2e (`apps/public/e2e`, scorer on 4173 + viewer on 4174, production builds): a scorer records
  a located 3, a miss and a rebound; the viewer's score updates **73 ms** after the tap (local;
  budget 2 s); the box row, play-by-play, shot chart and lineups are right; a late viewer loads
  the full history; an unknown slug shows "Game not found". Root `pnpm e2e` runs both apps.

## Phase 6 report

**Built:** derived stats as pure core functions over the effective log (`walk`, `boxScore`
with FIBA columns + EFF, `lineups`, `onOff` with per-40, `shotChart` with zones,
`playByPlay`/`describe`); court geometry and clock helpers moved into core; the public viewer app.

**Verified:** unit core 174 (hand-verified fixture game + property tests: team points = scoreboard
= sum of players; lineup minutes = time played; lineup +/- = margin; on + off = whole game), sync
49, scorer 71, public 3; e2e scorer 11 + viewer 2; viewer checked by eye at 390 px.

**Not verified / open:**
- Minutes need the scorer to record events while the clock runs. Time between the last event
  and "now" is not counted live; it lands when the next event (or period end) arrives.
- Stats recompute from the full log on each update: fine for a game (~1000 events), not measured
  on a low-end phone.
- No viewer batching (decision 7). Not load-tested with many viewers.
- The public app is not yet deployed (Vercel config is in place; hosting is Phase 7 or when you
  choose).

### Landscape phone layout (scorers hold phones sideways)

- `@media (max-height: 500px) and (orientation: landscape)` in `apps/scorer/src/index.css`:
  one-line scoreboard; players | pad | players; the control bar shares the bottom row with the
  footer; play-by-play/help/roles open as overlays; during a sub the roster shows in two
  columns; with shot locations on, the court sits beside a 2x2 block of shot buttons (bigger
  court). Player buttons stay 44 px (touch-target minimum).
- Manifest `orientation: landscape` (installed app). Portrait still works in a browser.
- e2e `landscape.spec.ts` at 844x390 and 740x360: idle, player selected, turnover picker, foul
  picker, FT bar, substitution with the whole roster, play-by-play, and a control-bar device, all
  with no vertical or horizontal scroll and the key buttons in the viewport.
- Test honesty note: the first version clipped `.live` (`height: 100vh; overflow: hidden`), which
  made "no scroll" pass trivially. Removed; the test then caught a 4 px overflow on 740x360.
- **Latency finding (open):** at 4x CPU throttle the first 1-2 taps after the game screen loads
  take 50-154 ms (warm-up); later taps have a median of ~13 ms. The p95 < 50 ms assertion sits
  near the edge and failed once in four runs. To address: warm-up or excluding the first taps
  from the budget is a decision, not a test tweak.

## Phase 7: admin, exports, season totals, latency

Assumptions (stated at the start, user asked to proceed while reviewing the redesign options):
admin screens live in the scorer app at `/admin` (brief: the scorer app serves scorers and
admins); admins sign in with email + password (no mail server needed); exports are built in the
browser; season totals are a pure core function. Out of scope: re-entering events a device had
refused (they stay on that device), email invites. Admin screens use the current styling and
will be restyled with the scorer once a visual direction is picked.

### Step 1: database

- Migration `20260927150000_admin`:
  - `players.default_jersey`, used to pre-fill game rosters (the roster keeps its per-game copy).
  - `add_league_admin(league, email)`: league admins add a co-admin by the email of an existing
    non-anonymous account; returns false if none.
  - `latency_samples` (game, device, kind `render`|`peer`, ms) + `record_latency(game, device,
    samples)` for scorer devices (members only, at most 500 per batch). Only league admins can
    read samples.
- pgTAP `08_admin` (11 tests). Test-side fixes on the way: read `auth.users` before logging in;
  Postgres rounds a float 12.5 half-to-even (compare the exact value); log in as the scorer before
  testing `record_latency` validation. Total pgTAP: 98.

### Step 2: season totals, CSV export, latency summary (core)

- `stats/season.ts`:
  - `seasonTotals(games)` with `games = [{ gameId, teams: {A: teamId, B: teamId}, events }]`:
    player totals + `gp` (got on the floor or recorded a stat) + per-game averages; team records
    keyed by the **real team id** (a club is A in one game and B in the next) with gp, wins,
    losses, points for/against. Unfinished games count as played, not as a win or loss.
  - `eventsCsv(events)`: raw export, envelope columns + `payload` as JSON, RFC 4180 quoting,
    CRLF; unconfirmed events have an empty `seq`.
  - `summarize(samples)`: n, p50, p95, max (for the latency dashboard).
- 9 tests; core total 183.

### Step 3: scorer uploads latency samples

- `logic/latency.ts` (+3 tests): `latencyUploader(send)` buffers `{kind, ms}` samples, uploads in
  batches of at most 500, keeps samples when an upload fails, drops the oldest past 2000.
  (Implementation written in the same pass as its tests.)
- Session: every tap-to-render sample (`measureTap`) and every peer fast-path receipt
  (`onPeerLatency`) is added; flushed every 15 s and when the app goes to the background, via
  `record_latency`. `window.__scorer.flushLatency()` for e2e.

### Step 4: admin screens (`/admin` in the scorer app)

- Loaded lazily (`import()` on `/admin`): the scorer bundle stays at 85 KB gzip, admin is a
  separate 7.5 KB chunk. `apps/scorer/vercel.json` rewrites `/admin*` to `index.html`.
- **Separate Supabase session** (`storageKey: 'stats-admin-auth'`), so an admin signing in on a
  scorer's device never replaces the scorer's anonymous session.
- Screens: sign in / create account (email + password) -> your leagues (create) -> league tabs:
  - **Games**: list; create (teams, season, rule set, one device / several devices, tip-off, shot
    locations). The roster is pre-filled from both teams (default jersey, else the next free
    number).
  - **Teams & players**: add teams; paste players one per line ("23 Kofi Mensah", "#7 Ama",
    "4. Yaw", or just a name) (`parsePlayers`, 3 tests).
  - **Seasons**, **Rule sets** (new from FIBA/NBA, edit the main numbers, validated with
    `RuleSetSchema` before saving), **Admins** (add by account email), **Season stats**
    (standings W-L, points for/against; player per-game averages over every game in the season).
  - **Game page**: viewer link, scorer codes (create, revoke), per-game jersey edits before tip-off,
    **lock** (with an in-page confirm), **CSV / JSON export** of the corrected log, **latency
    dashboard** (all devices and per device, tap -> own screen and tap -> other device: n,
    median, p95 in red when over budget (50 / 300 ms), max), and play-by-play with data-quality
    flags and admin corrections (remove, made/missed, 2/3), which still work after the lock.
- Admin writes go straight to `insert_event` with role `admin` (online only; no outbox needed).
- `VITE_PUBLIC_URL` sets the viewer base for links (default `http://localhost:5174`).

### Step 5: admin e2e

- `e2e/admin.spec.ts`: create account -> league -> FIBA rule set -> season -> two teams with pasted
  rosters -> game -> scorer code; a scorer joins with it and scores; the admin sees the live score
  and latency rows, exports CSV (header and a `shot` row checked), locks the game (the scorer's next
  event is refused with "game is locked"), corrects a shot after the lock, sees the player in season
  stats, and gets a clear message for an unknown co-admin email.

## Phase 7 report

**Built:** admin app (leagues, rule sets, seasons, teams/players, games/rosters, codes, lock,
corrections, CSV/JSON export, season stats, co-admins, latency dashboard), latency upload from
scorer devices, `seasonTotals` / `eventsCsv` / `summarize` in core, migration `*_admin`.

**Verified:** unit core 183, sync 49, scorer 77, public 3; pgTAP 98; e2e scorer 15 (incl. admin
journey) + viewer 2; typecheck clean.

**Not verified / open:**
- The `*_admin` migration is not yet on the hosted project.
- Hosted Supabase requires email confirmation for new accounts by default: new admins must
  confirm from the email (or turn confirmation off in the dashboard).
- No email invites; co-admins must create an account first.
- Refused events stay on the device that recorded them (no admin re-entry flow).
- Admin screens use the current look and will be restyled with the scorer's new direction.
- Latency warm-up: first 1-2 taps after load are slower (see landscape notes).

### Roster import from CSV (admin, Teams & players)

- Flow: upload a `.csv` or paste it -> **map the columns** (Full name, or First + Last; Jersey;
  Team; each "(not in file)" allowed) -> preview every row -> import.
- `admin/csv.ts` (pure, 11 tests):
  - `parseCsv`: quoted fields, delimiters/newlines inside quotes, doubled quotes, CRLF, BOM,
    blank lines; comma / semicolon / tab detected from the header line; cells trimmed; short
    rows padded. Hand-written (~40 lines) instead of adding a CSV library.
  - `guessMapping`: from header names (Player/Name, First/Given, Last/Surname/Family,
    Jersey/Shirt/Number/No./#, Team/Club).
  - `planImport`: per row `add` / `skip` / `error` with a reason: no name; jersey not 0-99/00;
    no team; duplicate row in the file (skip); already on that team (skip, name match ignoring
    case and spacing); jersey used twice on one team in the file. Team names match existing teams
    ignoring case (existing spelling kept); unknown teams are listed and created on import.
    Without a Team column, a "Add everyone to" team picker appears.
- `importRoster(league, plan)` creates the new teams, then inserts players per team with
  `default_jersey`.
- e2e: a messy file (renamed headers, quoted "Boateng, Yaw", wrong-case team, an existing player,
  a missing name, a clashing jersey): guessed mapping, preview reasons, remapping without a team
  column, import, resulting team counts. It caught the success message being hidden inside the
  collapsed section after import (fixed).
- Not done: names written "Last, First" are imported as written (could add a "swap Last, First"
  option).

## Redesign: direction C (court-first), chosen 2026-09-27

Mockups: https://claude.ai/artifact/Doh5nvgkJ1bChxzwdeRTM8 (A scoresheet, B broadcast, C court-first).
C: the court is the main input (player chip -> tap the court -> Made/Miss card at the spot),
players as jersey chips in two side rails, one bottom dock for everything else.

### Step 1: 12 shot sections (core)

- Research: NBA official stats combine a basic zone (restricted area, paint, mid-range, corner 3,
  above-the-break 3) with a left/centre/right area cut by angle from the basket; 82games uses 14
  zones (5 three-point, 5 mid-range, 4 paint); FIBA LiveStats records the exact spot.
- `court.ts`: `ZONES` (12, each with label and point value) and `shotZone(x, y)`:
  restricted area (1.25 m, FIBA no-charge arc), paint (4.9 x 5.8 m key), mid-range left/right
  baseline, left/right wing, top of key; left/right corner 3 (below 2.99 m); left/right wing 3,
  top 3. Area by angle from the basket: side < 30 deg, wing 30-78, centre 78-102. Left/right as
  drawn (baseline at the bottom). `zoneGroup()` maps sections to the 5 basic zones.
- The exact tap point is still stored (`x`, `y`); the section is derived, so charts keep full
  precision.
- `shotChart` now returns `zones` (12 per team) and `groups` (5 per team).
- Tests: 14 location cases + consistency of every section with `shotValue`; shot chart tests
  rewritten. Core: 196.

### Step 2: shared court (`packages/ui`) and the court-first scorer

- `packages/ui` (Preact, peer dep): `Court` draws the FIBA half court (150 x 140 SVG units,
  baseline at the bottom) with the 12 sections as SVG masks built from the real lines (arc, key,
  restricted arc, angle wedges), dashed section dividers, `highlight` (tapped section), `fills`
  (heat map), `labels` (e.g. "3/7") and `onTap` (normalised court coordinates). A test puts each
  section's label point through core's `shotZone`, so drawing and logic can't disagree. Used by
  the scorer and the viewer.
- Fonts bundled with the app (offline): Figtree (text) and Barlow Condensed 700/800 (numbers),
  via @fontsource, latin only.
- Scorer screen rebuilt in direction C:
  - Two **rails** (team name, big score, round jersey chips with last name and foul dots, fouls /
    timeouts / BONUS, team actions: Timeout (control device, labelled "Timeout <team>"),
    Team TO, Coach T, Bench T, Team REB during the rebound prompt). During a sub the rail shows
    the whole roster in 3 columns.
  - **Centre**: period + clock + online/sync top bar; the **court is the stage**. Select a player,
    tap the court: the section lights up, a hint names it ("Left wing 3"), and the Made/Missed
    card (value preset from the section, "switch to 2/3") pops up at the spot, clamped inside the
    court. "No spot" 2/3 buttons stay available. Games without shot locations get a big 2x2 shot
    grid instead of the court. Prompts, pickers and the sub panel appear as cards over a dimmed
    court; the FT bar floats at the top.
  - **Dock**: REB AST STL BLK TO FOUL SUB (enabled per selection and ownership), Cancel, Undo,
    and a ☰ menu (Play-by-play, Roles, End period, possession arrow, jump ball, keyboard help).
    Play-by-play, roles and help open as side drawers.
  - Court sizing uses container-query units so it always fits both the stage width and height.
  - Portrait phone: rails side by side on top, court below, dock on two rows.
  - Notices sit above the dock (never over the clock) and clear after 6 s.
- Bugs caught while restyling, all fixed: the court overflowed into the rails (sized from height
  only); the result card could leave the screen near a sideline; menu items opened a drawer and
  closed it in the same click (e2e); a take-over notice covered the clock (e2e).
- e2e updates: a `menu(page, item)` helper for items now in ☰; opponent selection shows the shot
  buttons disabled rather than hidden; the result card reads "3 Made". All 16 scorer e2e and 2
  viewer e2e pass; screenshots checked at 740x360, 844x390, 1180x820 and 390x844.

### Step 3: viewer in direction C, section heat map

- Viewer uses the same palette, fonts (bundled) and chip/number styling as the scorer: white
  sticky scoreboard, pill tabs, tables on white cards with a sticky name column.
- Shot chart = shared `Court` with a **heat map per section**: made/attempted label, colour
  from `heat(made, att)` (`format.ts`, tested): hue by FG% (blue 0% -> orange-red 100%),
  strength grows with attempts (capped) so one lucky shot doesn't look hot. Made dots / missed
  crosses on top in team colours; team filter; the 5-group table (restricted area, paint,
  mid-range, corner 3, above-break 3) beside it.
- Checked with a scripted game of 10 located shots: section labels, colours and the table agree.

### Section taps (user decision, 2026-09-27)

- Scorers tap a **section**, not an exact spot. `snapToSection(x, y)` (`packages/ui`) turns any
  tap into its section's reference point (the section label point); events keep storing `x`/`y`,
  now always that point, so `shotZone(x, y)` gives the section and no schema change was needed.
  Test: a grid of taps across the whole court each snap into their own section.
- Viewer: individual shot markers removed (they'd all sit on the section point); the chart is
  the section heat map with made/attempted labels.
- e2e: the viewer test checks the stored shot is the top-3 reference point (x 0.5, y 0.75), not
  the raw tap, and the chart shows one "1/1" section.

### Player names and photos

- Starters screen: cards with avatar, jersey and full name (selected = team-colour outline +
  check) instead of bare jersey circles. Live-scoring chips stay number-first.
- `players.photo` (migration `20260928090000_player_photos`): small inline image (data URL,
  must start with `data:image/`, <= 30 KB) so game info stays one request and photos work offline
  on scoring devices. `public_game` returns it for viewers. pgTAP `09_player_photos` (5).
  ponytail: move to Supabase Storage if full-size photos are ever needed.
- `packages/ui`: `Avatar` (photo or initials on the team colour), `initials()` (tested),
  `photoFromFile()` (centre-crop to 96x96 WebP in the browser, quality stepped down to fit).
- Admin Teams & players: each player row has avatar + a Photo/Change button (file picker).
- Viewer box score: small avatars next to names.
- `dev:game` uses realistic names ("Kwame Asante", "Kofi Amoah", ...) and default jerseys.
- e2e (admin journey): photo upload for Lions #4 -> the scorer's starter card for #4 shows it; #5
  shows initials and full name.
- Gotcha: Playwright `reuseExistingServer` silently tested a stale build while manual-test
  preview servers were running on 4173/4174. Stop them (or rebuild) before running e2e.

### Court re-cut into rings (user reference image, 2026-09-28)

- Sections now follow the standard shot-chart cut from the user's reference: **at the rim**
  (0-2.44 m / 8 ft circle), **short mid-range** ring (2.44-4.88 m / 8-16 ft), **long mid-range**
  from the ring to the arc in 5 slices (left/right baseline < 30 deg, left/right wing 30-78,
  top 78-102), **corner 3** left/right, **above-the-break 3** left/top/right. Still 12.
- Replaces restricted area + paint (which followed the painted key). Group names:
  `rim`, `shortMid`, `longMid`, `corner3`, `aboveBreak3`.
- `packages/ui`: rim circle and short ring drawn as dashed dividers; angle dividers start at
  the ring; label/snap points moved inside their new sections (tests pass). The key, FT circle
  and no-charge arc are drawn faintly (floor paint, not section boundaries).
- Tests: core 198 (16 location cases), ui 6; e2e 16 + 2. Screenshot check: the viewer heat map
  matches the reference layout.

### Re-tapping a section

- While the Made/Missed card is up, tapping another section moves the pending shot there
  (section, highlight and 2/3 value update). Entry machine: `court` input in the `shotResult`
  step. Unit test + e2e (tap top 3, then near the rim, "2 Made" -> one 2-point shot stored).

### Technical free throws: pick the shooter first (user-reported bug)

- After a coach/bench/player technical, the free throw has no fouled player; the machine needs a
  selected player of the shooting team, but the FT bar showed live Made/Missed buttons that did
  nothing. Now the bar reads "Technical FT: tap the <team> shooter" with Made/Missed disabled;
  once a player of that team is tapped it shows "FT 1/1 · #7 Name" and the buttons work.
- e2e: coach technical -> buttons disabled -> tap a Tigers player -> Made -> Tigers score 1.
- All e2e: scorer 18, viewer 2.

### Possession arrow as a rule-set setting

- `RuleSet.possessionArrow` (optional, defaults to true so older rule sets and events stay valid):
  FIBA preset on, NBA preset off. Admin rule-set editor has a checkbox.
- Scorer ☰ menu shows the arrow item only when the game's rules use it; "Jump won ..." sets the
  arrow only then.
- Event JSON Schema regenerated (`20260928090001_event_schema`).
- **Generator fix:** `pnpm db:event-schema` now stamps a new migration after the newest existing
  one (it used the UTC clock, which sorted before a hand-dated migration and made the CLI refuse
  it).
- e2e fixture `createGame(shotLocations, mode, rules)`; `pickStartersAndStart` accepts a 10:00 or
  12:00 period. New e2e: FIBA game shows the arrow, NBA game doesn't. All: core 200, e2e 19 + 2.

## Court sections on painted lines (2026-09-27)

- 12 sections, every edge a painted line or its extension: restricted area (no-charge arc), paint (non-RA, rest of the key), 5 mid-range (left/right baseline, left/right wing, top of key), 5 threes (left/right corner, left/right wing, top of key).
- Lane lines extended split top-of-key from wings (2s and 3s). The corner-line height (2.99 m, where the straight 3PT line meets the arc) splits corner/wing for both 2s and 3s: one dashed line from sideline to lane. First cut used the FT line extended for the 2s, which made the wing middies a thin strip under the arc.
- FIBA Points in the Paint (`TeamLine.pitp`) = made located shots in restricted + paint. Unlocated shots don't count. It's the only official FIBA location stat (Stats Manual 2024).
- Zones are derived from stored x/y, so no migration. Old events re-bucket automatically.
