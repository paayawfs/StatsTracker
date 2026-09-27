import { shotValue, teamFoulCount, type EventBody, type EventOf, type FoulKind, type GameEvent, type GameState, type PlayBody, type Team, type TURNOVER_KINDS } from '@stats/core';


type TurnoverKind = (typeof TURNOVER_KINDS)[number];
type Shot = EventOf<'shot'>;
type Turnover = EventOf<'turnover'>;
type FoulDraft = { team: Team; player: string; kind: FoulKind; fouled?: string };

/** Where the scorer is in the two-tap flow. Prompts never block: tapping elsewhere moves on. */
export type Entry =
  | { step: 'idle' }
  | { step: 'player'; player: string }
  | { step: 'shotResult'; player: string; x: number; y: number; value: 2 | 3 }
  | { step: 'assist'; shot: Shot }
  | { step: 'rebound'; shooterTeam: Team }
  | { step: 'turnoverKind'; team: Team; player?: string }
  | { step: 'steal'; turnover: Turnover }
  | { step: 'foulKind'; team: Team; player: string }
  | { step: 'fouled'; foul: FoulDraft }
  | { step: 'ftCount'; foul: FoulDraft }
  | { step: 'sub'; team: Team; out: string[]; in: string[] };

export type Input =
  | { kind: 'player'; id: string }
  | { kind: 'team'; team: Team }
  | { kind: 'shot'; value: 2 | 3; made: boolean }
  | { kind: 'court'; x: number; y: number }
  | { kind: 'flipValue' }
  | { kind: 'result'; made: boolean }
  | { kind: 'rebound' | 'turnover' | 'foul' | 'block' | 'steal' | 'assist' | 'sub' | 'confirm' | 'skip' }
  | { kind: 'turnoverKind'; value: TurnoverKind }
  | { kind: 'foulKind'; value: FoulKind }
  | { kind: 'ftCount'; n: 1 | 2 | 3 }
  | { kind: 'ft'; made: boolean }
  | { kind: 'teamTurnover'; team: Team }
  | { kind: 'benchFoul'; team: Team; offender: 'coach' | 'bench' }
  | { kind: 'timeout'; team: Team };

export interface Ctx {
  state: GameState;
  /** The effective log in canonical order, for "last shot" style lookups. */
  events: readonly GameEvent[];
  /** Wrap a body in an envelope (id, device, clock...). */
  stamp: (body: EventBody) => GameEvent;
  /** Multi mode: what this device may record. Omitted = everything (single mode). */
  can?: { team: (t: Team) => boolean; control: boolean };
}

export const idle: Entry = { step: 'idle' };
const other = (t: Team): Team => (t === 'A' ? 'B' : 'A');

function lastOf<T extends GameEvent>(events: readonly GameEvent[], match: (e: GameEvent) => e is T): T | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (match(e)) return e;
  }
  return undefined;
}
const isShot = (e: GameEvent): e is Shot => e.type === 'shot';
const isTurnover = (e: GameEvent): e is Turnover => e.type === 'turnover';
const isAttempt = (e: GameEvent): e is Shot | EventOf<'freeThrow'> => e.type === 'shot' || e.type === 'freeThrow';

function foulBody(f: FoulDraft & { offender: 'player' } & { freeThrows: number }): PlayBody;
function foulBody(f: { team: Team; offender: 'coach' | 'bench'; kind: FoulKind; freeThrows: number }): PlayBody;
function foulBody(f: { team: Team; offender: 'player' | 'coach' | 'bench'; player?: string; kind: FoulKind; fouled?: string; freeThrows: number }): PlayBody {
  return {
    type: 'foul',
    payload: {
      team: f.team,
      offender: f.offender,
      ...(f.offender === 'player' && f.player ? { player: f.player } : {}),
      kind: f.kind,
      ...(f.fouled ? { fouled: f.fouled } : {}),
      freeThrows: f.freeThrows,
    },
  };
}

/** One input -> events to record and the next entry state. Pure apart from `ctx.stamp`. */
export function step(entry: Entry, input: Input, ctx: Ctx): { entry: Entry; events: GameEvent[] } {
  const { state } = ctx;
  const out: GameEvent[] = [];
  const emit = <T extends GameEvent>(body: EventBody): T => {
    const e = ctx.stamp(body) as T;
    out.push(e);
    return e;
  };
  const done = (next: Entry = idle) => ({ entry: next, events: out });
  const teamOf = (id: string): Team | undefined => state.roster[id];
  const onFloor = (id: string) => {
    const t = teamOf(id);
    return !!t && state.onFloor[t].includes(id);
  };
  const amend = (target: GameEvent, patch: object) =>
    emit({ type: 'amend', payload: { targetId: target.id, body: { type: target.type, payload: { ...target.payload, ...patch } } as PlayBody } });

  const shoot = (shooter: string, value: 2 | 3, made: boolean, at: { x?: number; y?: number } = {}) => {
    const shot = emit<Shot>({ type: 'shot', payload: { shooter, value, made, ...at } });
    return done(made ? { step: 'assist', shot } : { step: 'rebound', shooterTeam: teamOf(shooter)! });
  };

  const finishFoul = (foul: FoulDraft) => {
    if (foul.kind === 'shooting' || foul.kind === 'unsportsmanlike' || foul.kind === 'disqualifying') return done({ step: 'ftCount', foul });
    if (foul.kind === 'offensive') {
      emit(foulBody({ ...foul, offender: 'player', freeThrows: 0 }));
      emit({ type: 'turnover', payload: { team: foul.team, player: foul.player, kind: 'offensiveFoul' } });
      return done();
    }
    // Personal: free throws follow from the team-foul bonus.
    const r = state.rules;
    const threshold = r ? (state.period > r.periods ? r.teamFoulBonus.overtimeThreshold : r.teamFoulBonus.threshold) : Infinity;
    const bonus = r && foul.fouled && teamFoulCount(state, foul.team) >= threshold ? r.teamFoulBonus.freeThrows : 0;
    emit(foulBody({ ...foul, offender: 'player', freeThrows: bonus }));
    return done();
  };

  const selected = entry.step === 'player' ? entry.player : undefined;
  const canTeam = (t: Team | undefined) => !!t && (ctx.can?.team(t) ?? true);
  const canControl = ctx.can?.control ?? true;

  // Team-level actions and free throws work from any step.
  switch (input.kind) {
    case 'timeout':
      if (!canControl) return done(entry);
      emit({ type: 'timeout', payload: { team: input.team } });
      return done();
    case 'teamTurnover':
      return done(canTeam(input.team) ? { step: 'turnoverKind', team: input.team } : entry);
    case 'benchFoul':
      if (!canTeam(input.team)) return done(entry);
      emit(foulBody({ team: input.team, offender: input.offender, kind: 'technical', freeThrows: state.rules?.technicalFreeThrows ?? 1 }));
      return done();
    case 'ft': {
      const due = state.freeThrowQueue[0];
      const shooter = due?.shooter ?? (selected && teamOf(selected) === due?.team ? selected : undefined);
      if (!due || !shooter || !canTeam(due.team)) return done(entry);
      emit({ type: 'freeThrow', payload: { shooter, made: input.made, attempt: due.next, of: due.of } });
      return done(!input.made && due.next === due.of ? { step: 'rebound', shooterTeam: due.team } : idle);
    }
  }

  // Prompt answers. Anything that isn't an answer falls through to normal selection.
  switch (entry.step) {
    case 'assist': {
      const shooter = entry.shot.payload.shooter;
      if (input.kind === 'player' && input.id !== shooter && teamOf(input.id) === teamOf(shooter) && onFloor(input.id)) {
        amend(entry.shot, { assist: input.id });
        return done();
      }
      break;
    }
    case 'rebound': {
      const kind = (t: Team) => (t === entry.shooterTeam ? 'offensive' : 'defensive');
      if (input.kind === 'player' && onFloor(input.id) && canTeam(teamOf(input.id))) {
        const t = teamOf(input.id)!;
        emit({ type: 'rebound', payload: { team: t, player: input.id, kind: kind(t) } });
        return done();
      }
      if (input.kind === 'team' && canTeam(input.team)) {
        emit({ type: 'rebound', payload: { team: input.team, kind: kind(input.team) } });
        return done();
      }
      break;
    }
    case 'steal':
      if (input.kind === 'player' && teamOf(input.id) === other(entry.turnover.payload.team) && onFloor(input.id)) {
        amend(entry.turnover, { steal: input.id });
        return done();
      }
      break;
    case 'turnoverKind':
      if (input.kind === 'turnoverKind' || input.kind === 'skip') {
        const kind = input.kind === 'turnoverKind' ? input.value : 'other';
        const turnover = emit<Turnover>({ type: 'turnover', payload: { team: entry.team, ...(entry.player ? { player: entry.player } : {}), kind } });
        return done({ step: 'steal', turnover });
      }
      break;
    case 'foulKind':
      if (input.kind === 'foulKind') {
        const foul: FoulDraft = { team: entry.team, player: entry.player, kind: input.value };
        if (input.value !== 'technical') return done({ step: 'fouled', foul });
        emit(foulBody({ ...foul, offender: 'player', freeThrows: state.rules?.technicalFreeThrows ?? 1 }));
        return done();
      }
      break;
    case 'fouled':
      if (input.kind === 'player' && teamOf(input.id) === other(entry.foul.team) && onFloor(input.id)) return finishFoul({ ...entry.foul, fouled: input.id });
      if (input.kind === 'skip') return finishFoul(entry.foul);
      break;
    case 'ftCount':
      if (input.kind === 'ftCount') {
        emit(foulBody({ ...entry.foul, offender: 'player', freeThrows: input.n }));
        return done();
      }
      break;
    case 'shotResult':
      if (input.kind === 'flipValue') return done({ ...entry, value: entry.value === 2 ? 3 : 2 });
      if (input.kind === 'result') return shoot(entry.player, entry.value, input.made, { x: entry.x, y: entry.y });
      break;
    case 'sub':
      // A sub is modal: it only finishes on confirm or skip.
      if (input.kind === 'player') {
        if (teamOf(input.id) !== entry.team) return done(entry);
        const key = state.onFloor[entry.team].includes(input.id) ? 'out' : 'in';
        const list = entry[key].includes(input.id) ? entry[key].filter((id) => id !== input.id) : [...entry[key], input.id];
        return done({ ...entry, [key]: list });
      }
      if (input.kind === 'confirm' && entry.out.length + entry.in.length) {
        emit({ type: 'substitution', payload: { team: entry.team, out: entry.out, in: entry.in } });
      }
      return done(input.kind === 'confirm' || input.kind === 'skip' ? idle : entry);
  }

  // Selection and player-first actions.
  if (input.kind === 'player') return done({ step: 'player', player: input.id });
  if (input.kind === 'skip') return done();
  const team = selected ? teamOf(selected) : undefined;
  if (!selected || !team) return done(entry);
  // Primary actions belong to the selected player's team; amends (block/steal/assist) don't.
  const primary = ['shot', 'court', 'rebound', 'turnover', 'foul', 'sub'].includes(input.kind);
  if (primary && !canTeam(team)) return done(entry);

  switch (input.kind) {
    case 'shot':
      return shoot(selected, input.value, input.made);
    case 'court':
      return done({ step: 'shotResult', player: selected, x: input.x, y: input.y, value: shotValue(input.x, input.y) });
    case 'rebound': {
      const lastAttempt = lastOf(ctx.events, isAttempt);
      const shooterTeam = lastAttempt ? teamOf(lastAttempt.payload.shooter) : undefined;
      emit({ type: 'rebound', payload: { team, player: selected, kind: shooterTeam === team ? 'offensive' : 'defensive' } });
      return done();
    }
    case 'turnover':
      return done({ step: 'turnoverKind', team, player: selected });
    case 'foul':
      return done({ step: 'foulKind', team, player: selected });
    case 'sub': {
      const playing = state.onFloor[team].includes(selected);
      return done({ step: 'sub', team, out: playing ? [selected] : [], in: playing ? [] : [selected] });
    }
    case 'block': {
      const shot = lastOf(ctx.events, isShot);
      if (shot && !shot.payload.made && !shot.payload.block && teamOf(shot.payload.shooter) === other(team)) amend(shot, { block: selected });
      return done();
    }
    case 'steal': {
      const to = lastOf(ctx.events, isTurnover);
      if (to && !to.payload.steal && to.payload.team === other(team)) amend(to, { steal: selected });
      return done();
    }
    case 'assist': {
      const shot = lastOf(ctx.events, isShot);
      if (shot && shot.payload.made && !shot.payload.assist && shot.payload.shooter !== selected && teamOf(shot.payload.shooter) === team) amend(shot, { assist: selected });
      return done();
    }
  }
  return done(entry);
}
