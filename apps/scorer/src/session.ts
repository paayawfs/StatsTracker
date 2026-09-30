import { computed, signal } from '@preact/signals';
import { initialState, periodLength, type EventBody, type EventOf, type GameEvent, type GameState, type Role, type RuleSet, type Team } from '@stats/core';
import { GameSync, LocalStore, SupabaseTransport, supabaseClientOptions } from '@stats/sync';
import { createClient } from '@supabase/supabase-js';
import { describe as describeEvent, remaining } from '@stats/core';
import { idle, step, type Entry, type Input } from './logic/entry';
import { keyCommand, promptTeam, resolveJersey } from './logic/keys';
import { capabilities, heldRoles, roleFor } from './logic/ownership';
import { latencyUploader } from './logic/latency';
import { undoLast } from './logic/undo';

const LOCAL_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:54321',
  import.meta.env.VITE_SUPABASE_ANON_KEY ?? LOCAL_ANON,
  supabaseClientOptions,
);

export interface Player {
  id: string;
  name: string;
  jersey: string;
  team: Team;
  /** Small inline photo (data URL), if the admin added one. */
  photo?: string | null;
}
/** Everything needed to score a game, cached so the app can resume offline. */
export interface GameInfo {
  gameId: string;
  teams: Record<Team, string>;
  players: Player[];
  rules: RuleSet;
  shotLocations: boolean;
  mode: 'single' | 'multi';
}

const INFO_KEY = 'scorer.game';
const DEVICE_KEY = 'scorer.device';

function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) localStorage.setItem(DEVICE_KEY, (id = crypto.randomUUID()));
  return id;
}

// ---- reactive state -------------------------------------------------------------------------
export const info = signal<GameInfo | null>(null);
export const state = signal<GameState>(initialState);
export const events = signal<readonly GameEvent[]>([]);
export const entry = signal<Entry>(idle);
export const online = signal(false);
export const pending = signal(0);
export const rejected = signal<{ event: GameEvent; reason: string }[]>([]);
export const notice = signal<string | null>(null);
/** Ticks ~10x/s while the clock runs so the display counts down. */
export const now = signal(Date.now());
/** Tap-to-render samples (ms) for this session. Uploaded in Phase 7. */
export const tapToRender = signal<number[]>([]);

/** Peer fast-path latency samples (ms): tap on another device -> received here. */
export const peerLatency = signal<number[]>([]);
export const myDevice = signal('');
/** Roles this device holds and what it may record. */
export const myRoles = computed(() => heldRoles(state.value, myDevice.value));
export const can = computed(() => capabilities(state.value, myDevice.value));

export const playersById = computed(() => new Map((info.value?.players ?? []).map((p) => [p.id, p])));

let sync: GameSync | null = null;
/** Latency samples go to the server for the admin dashboard (brief section 4). */
let uploader: ReturnType<typeof latencyUploader> | null = null;
let lastStamp = { deviceSeq: 0, wallClock: 0 };
/** Ids already undone plus undo markers; kept per game so Undo after a reload doesn't undo an undo. */
let undone = new Set<string>();
const undoneKey = (gameId: string) => `scorer.undone.${gameId}`;
/** Stops the timers and listeners of the open game. */
let stopTimers = () => {};
/** A peer's miss this phone should take the defensive rebound for, while it was busy. */
let deferredRebound: Team | null = null;
/** Roles this device just released, so losing them isn't reported as a take-over. */
const releasing = new Set<Role>();

// ---- joining and resuming -------------------------------------------------------------------
export async function join(code: string): Promise<void> {
  const { data: session } = await supabase.auth.getSession();
  if (!session.session) {
    const { error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
  }
  const joined = await supabase.rpc('join_game', { join_code: code.trim(), device: deviceId() });
  if (joined.error) throw new Error(joined.error.message);
  const gameInfo = await loadInfo(joined.data as string);
  localStorage.setItem(INFO_KEY, JSON.stringify(gameInfo));
  await open(gameInfo);
}

async function loadInfo(gameId: string): Promise<GameInfo> {
  const g = await supabase.from('games').select('id, mode, shot_locations, team_a, team_b, rule_sets(rules)').eq('id', gameId).single();
  if (g.error) throw new Error(g.error.message);
  const teams = await supabase.from('teams').select('id, name').in('id', [g.data.team_a, g.data.team_b]);
  const roster = await supabase.from('game_roster').select('player_id, team, jersey, players(name, photo)').eq('game_id', gameId);
  if (teams.error || roster.error) throw new Error((teams.error ?? roster.error)!.message);
  const name = (id: string) => teams.data.find((t) => t.id === id)?.name ?? '';
  return {
    gameId,
    mode: g.data.mode,
    shotLocations: g.data.shot_locations,
    rules: (g.data.rule_sets as unknown as { rules: RuleSet }).rules,
    teams: { A: name(g.data.team_a), B: name(g.data.team_b) },
    players: roster.data
      .map((r) => {
        const p = r.players as unknown as { name: string; photo: string | null };
        return { id: r.player_id, team: r.team as Team, jersey: r.jersey, name: p.name, photo: p.photo };
      })
      .sort((a, b) => a.team.localeCompare(b.team) || Number(a.jersey) - Number(b.jersey) || a.jersey.localeCompare(b.jersey)),
  };
}

/** Resume the last game on this device, offline if need be. */
export async function resume(): Promise<boolean> {
  const cached = localStorage.getItem(INFO_KEY);
  if (!cached) return false;
  await open(JSON.parse(cached) as GameInfo);
  return true;
}

export function leave() {
  stopTimers();
  sync?.close();
  sync = null;
  void uploader?.flush();
  uploader = null;
  localStorage.removeItem(INFO_KEY);
  info.value = null;
  state.value = initialState;
  events.value = [];
  entry.value = idle;
  notice.value = null;
  online.value = false;
  pending.value = 0;
  rejected.value = [];
  peerLatency.value = [];
  releasing.clear();
}

async function open(gameInfo: GameInfo) {
  stopTimers();
  const store = await LocalStore.open();
  sync = await GameSync.open({ gameId: gameInfo.gameId, deviceId: deviceId(), transport: new SupabaseTransport(supabase, gameInfo.gameId), store });
  const s = sync;
  let lastSeen = s.log.events.at(-1)?.id;
  let prevRoles = heldRoles(s.log.state, s.deviceId);
  try {
    undone = new Set(JSON.parse(localStorage.getItem(undoneKey(s.gameId)) ?? '[]') as string[]);
  } catch {
    undone = new Set();
  }
  const refresh = () => {
    if (sync !== s) return; // a request that finished after Leave game
    // A half-entered play doesn't carry over a period end or start (a peer's, or this phone's).
    if (s.log.state.phase !== state.value.phase || s.log.state.period !== state.value.period) {
      entry.value = idle;
      deferredRebound = null;
    }
    state.value = s.log.state;
    events.value = s.log.events.slice(); // GameLog mutates one array; a new one notifies signals
    const last = s.log.events.at(-1);
    if (last && last.id !== lastSeen) {
      lastSeen = last.id;
      if (last.deviceId !== s.deviceId) onPeerEvent(last);
    }
    const roles = heldRoles(s.log.state, s.deviceId);
    const lost = prevRoles.filter((r) => !roles.includes(r));
    const gained = roles.filter((r) => !prevRoles.includes(r));
    const takenOver = lost.filter((r) => !releasing.has(r));
    for (const r of lost) releasing.delete(r);
    if (takenOver.length) notice.value = `Your ${takenOver.map(roleName).join(' and ')} role was taken over by another device.`;
    else if (lost.length) notice.value = null;
    else if (gained.length && prevRoles.length) notice.value = `You now hold ${gained.map(roleName).join(' and ')}.`;
    prevRoles = roles;
    online.value = s.online && navigator.onLine;
    pending.value = s.log.events.filter((e) => e.seq === null && e.deviceId === s.deviceId).length;
    rejected.value = s.rejected.map((r) => ({ event: r.event, reason: r.rejected ?? '' }));
  };
  s.onChange = refresh;
  uploader = latencyUploader(async (batch) => {
    const { error } = await supabase.rpc('record_latency', { game: s.gameId, device: s.deviceId, samples: batch });
    if (error) throw error;
  });
  const up = uploader;
  const onHide = () => document.visibilityState === 'hidden' && void up.flush();
  document.addEventListener('visibilitychange', onHide);
  const timers = [setInterval(() => void up.flush(), 15_000)];
  s.onPeerLatency = (_, ms) => {
    peerLatency.value = [...peerLatency.value.slice(-199), ms];
    up.add('peer', ms);
  };
  s.onRejected = (_, reason) => (notice.value = `The server refused an event: ${reason}`);
  s.onConflict = () => (notice.value = 'Another scorer changed an event you corrected. The latest change wins.');
  timers.push(
    setInterval(() => {
      online.value = s.online && navigator.onLine;
      if (state.value.clock.running) now.value = s.now();
    }, 100),
  );
  stopTimers = () => {
    timers.forEach(clearInterval);
    document.removeEventListener('visibilitychange', onHide);
    stopTimers = () => {};
  };
  myDevice.value = s.deviceId;
  info.value = gameInfo;
  refresh();
  void navigator.storage?.persist?.();
  claimRole();
}

/** Single mode claims its one role automatically; multi mode shows the role picker. */
function claimRole() {
  if (info.value!.mode === 'single' && !myRoles.value.length) claim('single');
}

export function roleName(r: Role): string {
  const t = info.value?.teams;
  return r === 'teamA' ? (t?.A ?? 'Team A') : r === 'teamB' ? (t?.B ?? 'Team B') : r === 'clock' ? 'Clock' : r === 'single' ? 'Scorer' : 'Admin';
}

export function claim(role: Role) {
  notice.value = null;
  record({ type: 'roleClaim', payload: { role } }, { role });
}

/** Take a role held by another (e.g. dead) device. Allowed for any joined scorer. */
export function takeOver(role: Role) {
  notice.value = null;
  record({ type: 'roleTransfer', payload: { role, toDeviceId: sync!.deviceId } }, { role });
}

export function release(role: Role) {
  releasing.add(role);
  record({ type: 'roleRelease', payload: { role } }, { role });
}

/** Multi mode: prompt this device for what a peer's event leaves it to record. */
function onPeerEvent(e: GameEvent) {
  const st = state.value;
  const miss = (e.type === 'shot' && !e.payload.made) || (e.type === 'freeThrow' && !e.payload.made && e.payload.attempt === e.payload.of);
  if (miss) {
    const shooterTeam = st.roster[e.payload.shooter];
    const defending: Team | undefined = shooterTeam === 'A' ? 'B' : shooterTeam === 'B' ? 'A' : undefined;
    // The defending team's device records the defensive rebound (decision 3).
    if (shooterTeam && defending && can.value.team(defending) && !can.value.team(shooterTeam)) {
      // Busy with another entry: ask once it's done.
      if (entry.value.step === 'idle') entry.value = { step: 'rebound', shooterTeam };
      else deferredRebound = shooterTeam;
    }
  } else if (['rebound', 'shot', 'turnover', 'periodEnd', 'freeThrow'].includes(e.type)) {
    deferredRebound = null;
    if (entry.value.step === 'rebound') entry.value = idle; // someone else answered it
  }
}

// ---- recording --------------------------------------------------------------------------------
export const clockNow = () => (sync ? remaining(state.value.clock, sync.now()) : 0);

function stamp(body: EventBody, env: Partial<Pick<GameEvent, 'period' | 'gameClock' | 'role'>> = {}): GameEvent {
  const s = sync!;
  const st = state.value;
  // Strictly increasing within a device, so two events from one tap keep their order.
  lastStamp = {
    deviceSeq: Math.max(s.nextDeviceSeq(), lastStamp.deviceSeq + 1),
    wallClock: Math.max(Math.round(s.now()), lastStamp.wallClock + 1),
  };
  return {
    id: crypto.randomUUID(),
    gameId: s.gameId,
    seq: null,
    deviceId: s.deviceId,
    role: roleFor(body, st, s.deviceId) ?? heldRoles(st, s.deviceId)[0] ?? (info.value?.mode === 'single' ? 'single' : 'teamA'),
    period: st.phase === 'pregame' ? 0 : st.period,
    gameClock: st.phase === 'pregame' ? 0 : Math.round(clockNow()),
    ...lastStamp,
    ...env,
    ...body,
  } as GameEvent;
}

export function record(body: EventBody, env?: Partial<Pick<GameEvent, 'period' | 'gameClock' | 'role'>>) {
  sync?.record(stamp(body, env));
}

/** Feed a tap into the entry machine and record whatever it emits. */
export function input(i: Input) {
  if (!sync) return;
  const r = step(entry.value, i, { state: state.value, events: sync.log.events, stamp: (b) => stamp(b), can: can.value });
  // A BLK/STL/AST with nothing to attach to records nothing: say so rather than look recorded.
  const missing = { block: 'a missed shot by the other team', steal: 'a turnover by the other team', assist: "a made shot by a teammate that has no assist" } as const;
  if (!r.events.length && i.kind in missing && entry.value.step === 'player') notice.value = `Nothing to attach that to: no ${missing[i.kind as keyof typeof missing]}.`;
  entry.value = r.entry;
  for (const e of r.events) sync.record(e);
  if (deferredRebound && entry.value.step === 'idle' && state.value.reboundable) {
    entry.value = { step: 'rebound', shooterTeam: deferredRebound };
    deferredRebound = null;
  }
}

export function undo() {
  if (!sync) return;
  // Another tab of this game may have undone something since this one loaded.
  try {
    for (const id of JSON.parse(localStorage.getItem(undoneKey(sync.gameId)) ?? '[]') as string[]) undone.add(id);
  } catch {
    // keep what this tab has
  }
  const u = undoLast(sync.log, sync.deviceId, undone);
  if (!u) return;
  const target = sync.log.get(u.undoes);
  if (target) notice.value = `Undone: ${describeEvent(target, (id) => { const p = id ? playersById.value.get(id) : undefined; return p ? `#${p.jersey} ${p.name}` : 'team'; }, info.value?.teams)}`;
  const marker = stamp(u.body);
  undone.add(u.undoes).add(marker.id);
  localStorage.setItem(undoneKey(sync.gameId), JSON.stringify([...undone]));
  sync.record(marker);
  entry.value = idle;
}

export function correct(body: EventOf<'amend'>['payload'] | EventOf<'void'>['payload'], kind: 'amend' | 'void') {
  record({ type: kind, payload: body } as EventBody);
}

// ---- game control ---------------------------------------------------------------------------
export function startGame(lineups: Record<Team, string[]>) {
  const gi = info.value!;
  const roster = (t: Team) => gi.players.filter((p) => p.team === t).map((p) => ({ playerId: p.id, jersey: p.jersey }));
  if (!state.value.rules) record({ type: 'gameStart', payload: { rules: gi.rules, shotLocations: gi.shotLocations, roster: { A: roster('A'), B: roster('B') } } }, { period: 0, gameClock: 0 });
  record({ type: 'periodStart', payload: { lineups } }, { period: 1, gameClock: periodLength(gi.rules, 1) });
}

export function toggleClock() {
  const st = state.value;
  if (st.phase !== 'live' || !can.value.control) return;
  record({ type: st.clock.running ? 'clockStop' : 'clockStart', payload: {} });
}

/** Set the clock to match the official scoreboard (recorded as a stop at that time). */
export function setClock(ms: number) {
  if (!can.value.control) return;
  record({ type: 'clockStop', payload: {} }, { gameClock: ms });
}

export function endPeriod() {
  if (!can.value.control) return;
  if (state.value.clock.running) record({ type: 'clockStop', payload: {} });
  record({ type: 'periodEnd', payload: {} }, { gameClock: 0 });
  entry.value = idle;
}

export function checkpoint(score: Record<Team, number>) {
  record({ type: 'checkpoint', payload: { score } }, { gameClock: 0 });
}

export function nextPeriod() {
  const st = state.value;
  const period = st.period + 1;
  record({ type: 'periodStart', payload: { lineups: { A: [...st.onFloor.A], B: [...st.onFloor.B] } } }, { period, gameClock: periodLength(st.rules!, period) });
}

export function endGame() {
  record({ type: 'gameEnd', payload: {} }, { gameClock: 0 });
}

/** Record a tap-to-render sample: call at pointerdown, measures to the next painted frame. */
export function measureTap(start: number) {
  requestAnimationFrame(() =>
    setTimeout(() => {
      const ms = performance.now() - start;
      tapToRender.value = [...tapToRender.value.slice(-199), ms];
      uploader?.add('render', ms);
    }),
  );
}

// ---- keyboard (laptop) --------------------------------------------------------------------------
/** Jersey digits typed so far. */
export const typed = signal('');
export const showHelp = signal(false);
/** Team a typed jersey resolves to when both teams have the number. Tab flips it. */
export const preferTeam = signal<Team>('A');
let jerseyTimer: ReturnType<typeof setTimeout> | undefined;

function commitJersey() {
  clearTimeout(jerseyTimer);
  const jersey = typed.value;
  typed.value = '';
  if (!jersey || !info.value) return;
  const st = state.value;
  const prefer = promptTeam(entry.value, (id) => st.roster[id], preferTeam.value);
  const id = resolveJersey(jersey, prefer, info.value.players, st.onFloor, entry.value.step === 'sub');
  if (!id) return;
  preferTeam.value = st.roster[id] ?? preferTeam.value;
  input({ kind: 'player', id });
}

export function onKey(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey || (e.target instanceof HTMLElement && e.target.closest('input, textarea'))) return;
  if (!info.value || state.value.phase === 'pregame') return;
  if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLElement && e.target.closest('button')) return;
  if (e.key === 'Tab' && !typed.value && entry.value.step === 'idle') return;
  const cmd = keyCommand(e, entry.value);
  if (!cmd) return;
  e.preventDefault();
  const t = performance.now();
  if ('digit' in cmd) {
    typed.value += cmd.digit;
    clearTimeout(jerseyTimer);
    jerseyTimer = setTimeout(commitJersey, 400);
    return;
  }
  if ('input' in cmd) {
    if (typed.value) commitJersey();
    input(cmd.input);
  } else {
    switch (cmd.do) {
      case 'clock': toggleClock(); break;
      case 'undo': undo(); break;
      case 'help': showHelp.value = !showHelp.value; break;
      case 'commit': commitJersey(); break;
      case 'commitOrConfirm': if (typed.value) commitJersey(); else input({ kind: 'confirm' }); break;
      case 'switchTeam': {
        preferTeam.value = preferTeam.value === 'A' ? 'B' : 'A';
        // Re-point a just-selected shared jersey at the other team.
        const e2 = entry.value;
        const p = e2.step === 'player' ? info.value.players.find((x) => x.id === e2.player) : undefined;
        const twin = p && info.value.players.find((x) => x.jersey === p.jersey && x.team === preferTeam.value && state.value.onFloor[x.team].includes(x.id));
        if (twin) input({ kind: 'player', id: twin.id });
        break;
      }
    }
  }
  measureTap(t);
}

/** Upload buffered latency samples now (also runs every 15 s and when the app is hidden). */
export const flushLatency = () => uploader?.flush();
