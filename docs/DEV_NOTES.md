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
