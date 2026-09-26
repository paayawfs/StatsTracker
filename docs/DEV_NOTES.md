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
