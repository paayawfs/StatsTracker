import { useComputed, useSignal } from '@preact/signals';
import { describe as describeEvent, FOUL_KINDS, teamFoulCount, timeoutsAllowed, type GameEvent, type Role, type Team } from '@stats/core';
import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { formatClock, remaining } from '@stats/core';
import type { Input } from './logic/entry';
import {
  can, checkpoint, claim, correct, endGame, endPeriod, entry, events, info, input, join, measureTap, myDevice, myRoles, nextPeriod, notice, now, online, record, release, roleName, takeOver,
  pending, playersById, rejected, resume, setClock, showHelp, startGame, state, tapToRender, toggleClock, typed, undo, type Player,
} from './session';

/** Fire on pointerdown (not click) and record tap-to-render. */
const tap = (fn: () => void) => ({
  onPointerDown: (e: PointerEvent) => {
    const t = performance.now();
    e.preventDefault();
    fn();
    measureTap(t);
  },
});
const send = (i: Input) => tap(() => input(i));

export function App() {
  const ready = useSignal(false);
  useEffect(() => {
    void resume().finally(() => (ready.value = true));
  }, []);
  if (!ready.value) return null;
  if (!info.value) return <Join />;
  if (info.value.mode === 'multi' && !myRoles.value.length) return <RolePicker />;
  if (state.value.phase === 'pregame') return <Pregame />;
  return <Live />;
}

function Join() {
  const code = useSignal('');
  const error = useSignal('');
  const busy = useSignal(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    busy.value = true;
    error.value = '';
    try {
      await join(code.value);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      busy.value = false;
    }
  };
  return (
    <form class="join" onSubmit={submit}>
      <h1>Scorer</h1>
      <label>
        Game code
        <input value={code.value} onInput={(e) => (code.value = e.currentTarget.value.toUpperCase())} autoFocus autocomplete="off" maxLength={8} />
      </label>
      <button disabled={busy.value || code.value.length < 8}>{busy.value ? 'Joining…' : 'Join game'}</button>
      {error.value && <p class="error">{error.value}</p>}
    </form>
  );
}

function Pregame() {
  const gi = info.value!;
  const starters = useSignal<Record<Team, string[]>>({ A: [], B: [] });
  const toggle = (p: Player) => {
    const list = starters.value[p.team];
    starters.value = { ...starters.value, [p.team]: list.includes(p.id) ? list.filter((id) => id !== p.id) : [...list, p.id] };
  };
  const ok = starters.value.A.length === 5 && starters.value.B.length === 5;
  if (!can.value.control) {
    return (
      <div class="pregame">
        <h1>Waiting for the game to start</h1>
        <p>
          You score {myRoles.value.map(roleName).join(' and ')}. The {state.value.roles.clock ? 'Clock' : roleName('teamA')} device picks the
          starters and starts the game.
        </p>
        <Roles />
      </div>
    );
  }
  return (
    <div class="pregame">
      <h1>Confirm starters</h1>
      <div class="teams">
        {(['A', 'B'] as const).map((t) => (
          <section key={t}>
            <h2>
              {gi.teams[t]} <small>{starters.value[t].length}/5</small>
            </h2>
            {gi.players.filter((p) => p.team === t).map((p) => (
              <button key={p.id} class={starters.value[t].includes(p.id) ? 'player on' : 'player'} onClick={() => toggle(p)} data-testid={`starter-${p.jersey}-${t}`}>
                <b>{p.jersey}</b> {p.name}
              </button>
            ))}
          </section>
        ))}
      </div>
      <button class="primary" disabled={!ok} onClick={() => startGame(starters.value)}>
        Start game
      </button>
      {!ok && <p>Pick exactly 5 starters for each team.</p>}
    </div>
  );
}

function Live() {
  const phase = state.value.phase;
  const showLog = useSignal(false);
  const showRoles = useSignal(false);
  return (
    <div class="live">
      <Scoreboard />
      {phase === 'live' && can.value.control && <ControlBar />}
      {notice.value && (
        <div class="notice" onClick={() => (notice.value = null)}>
          {notice.value}
        </div>
      )}
      {phase === 'live' ? (
        <main class="court-layout">
          <TeamPanel team="A" />
          <ActionPad />
          <TeamPanel team="B" />
        </main>
      ) : (
        <Break />
      )}
      <footer>
        <button class="undo" {...tap(undo)} data-testid="undo">
          Undo
        </button>
        {phase === 'live' && can.value.control && <button onClick={endPeriod}>End period</button>}
        {info.value!.mode === 'multi' && <button onClick={() => (showRoles.value = !showRoles.value)}>Roles</button>}
        <button onClick={() => (showLog.value = !showLog.value)}>{showLog.value ? 'Hide' : 'Play-by-play'}</button>
      </footer>
      {showLog.value && <PlayByPlay />}
      {showHelp.value && <Help />}
      {showRoles.value && (
        <aside class="help">
          <Roles />
          <button onClick={() => (showRoles.value = false)}>Close</button>
        </aside>
      )}
    </div>
  );
}

function Scoreboard() {
  const gi = info.value!;
  const clock = useComputed(() => formatClock(remaining(state.value.clock, now.value)));
  return (
    <header class="scoreboard">
      <TeamScore team="A" name={gi.teams.A} />
      <div class="clock">
        <button class={state.value.clock.running ? 'time running' : 'time'} {...tap(toggleClock)} data-testid="clock">
          {clock}
        </button>
        <span>
          P{state.value.period} · {online.value ? 'online' : 'offline'}
          {pending.value ? ` · ${pending.value} to sync` : ''}
        </span>
        {can.value.control && <ClockAdjust />}
      </div>
      <TeamScore team="B" name={gi.teams.B} />
    </header>
  );
}

function ClockAdjust() {
  const open = useSignal(false);
  const value = useSignal('');
  if (!open.value) return <button class="link" onClick={() => ((open.value = true), (value.value = formatClock(state.value.clock.gameClock)))}>set</button>;
  const apply = () => {
    const [m, s] = value.value.includes(':') ? value.value.split(':') : ['0', value.value];
    const ms = Math.round((Number(m) * 60 + Number(s)) * 1000);
    if (Number.isFinite(ms) && ms >= 0) setClock(ms);
    open.value = false;
  };
  return (
    <span class="clock-set">
      <input value={value.value} onInput={(e) => (value.value = e.currentTarget.value)} size={5} />
      <button onClick={apply}>ok</button>
    </span>
  );
}

function TeamScore({ team, name }: { team: Team; name: string }) {
  const score = useComputed(() => state.value.score[team]);
  const fouls = useComputed(() => teamFoulCount(state.value, team));
  const bonus = useComputed(() => {
    const r = state.value.rules;
    return !!r && fouls.value >= (state.value.period > r.periods ? r.teamFoulBonus.overtimeThreshold : r.teamFoulBonus.threshold);
  });
  const timeouts = useComputed(() => {
    const r = state.value.rules;
    if (!r) return 0;
    const w = timeoutsAllowed(r, state.value.period);
    return w.count - w.periods.reduce((n, p) => n + (state.value.timeouts[team][p] ?? 0), 0);
  });
  return (
    <div class={`team-score team-${team}`}>
      <span class="name">{name}</span>
      <span class="score" data-testid={`score-${team}`}>
        {score}
      </span>
      <span class="meta">
        Fouls {fouls}
        {bonus.value && <b> BONUS</b>} · TO left {timeouts}
      </span>
    </div>
  );
}

function TeamPanel({ team }: { team: Team }) {
  const lineup = useComputed(() => state.value.onFloor[team].join(','));
  const subbing = useComputed(() => entry.value.step === 'sub' && entry.value.team === team);
  const rebounding = useComputed(() => entry.value.step === 'rebound');
  const ids = subbing.value
    ? info.value!.players.filter((p) => p.team === team).map((p) => p.id)
    : lineup.value.split(',').filter(Boolean);
  return (
    <section class={`team team-${team}${subbing.value ? " subbing" : ""}`}>
      <div class="players">
        {ids.map((id) => (
          <PlayerButton key={id} id={id} />
        ))}
      </div>
      <div class="team-actions">
        {can.value.team(team) && (
          <>
            {rebounding.value && <button {...send({ kind: 'team', team })}>Team REB</button>}
            <button {...send({ kind: 'teamTurnover', team })}>Team TO</button>
            <button {...send({ kind: 'benchFoul', team, offender: 'coach' })}>Coach T</button>
            <button {...send({ kind: 'benchFoul', team, offender: 'bench' })}>Bench T</button>
          </>
        )}
      </div>
    </section>
  );
}

function PlayerButton({ id }: { id: string }) {
  const p = playersById.value.get(id);
  const fouls = useComputed(() => state.value.personalFouls[id] ?? 0);
  const cls = useComputed(() => {
    const e = entry.value;
    const onFloor = state.value.onFloor.A.includes(id) || state.value.onFloor.B.includes(id);
    const picked =
      (e.step === 'player' && e.player === id) ||
      (e.step === 'sub' && (e.out.includes(id) || e.in.includes(id)));
    const out = !!state.value.rules && fouls.value >= state.value.rules.personalFoulLimit;
    return ['player', picked && 'on', !onFloor && 'bench', out && 'fouled-out'].filter(Boolean).join(' ');
  });
  if (!p) return null;
  return (
    <button class={cls} {...send({ kind: 'player', id })} data-testid={`player-${p.team}-${p.jersey}`}>
      <b>{p.jersey}</b>
      <span>{p.name}</span>
      <i class="fouls">{'●'.repeat(fouls.value)}</i>
    </button>
  );
}

const TURNOVERS = [
  ['badPass', 'Bad pass'], ['ballHandling', 'Lost ball'], ['travelling', 'Travel'], ['doubleDribble', 'Double dribble'],
  ['outOfBounds', 'Out of bounds'], ['threeSeconds', '3 sec'], ['fiveSeconds', '5 sec'], ['eightSeconds', '8 sec'],
  ['shotClock', 'Shot clock'], ['backcourt', 'Backcourt'], ['offensiveFoul', 'Off. foul'],
] as const;

function ActionPad() {
  const e = entry.value;
  const gi = info.value!;
  const who = (id: string) => {
    const p = playersById.value.get(id);
    return p ? `#${p.jersey} ${p.name}` : '';
  };
  let body: JSX.Element;
  switch (e.step) {
    case 'idle':
      body = <p class="hint">Tap a player</p>;
      break;
    case 'player': {
      const team = state.value.roster[e.player];
      if (team && !can.value.team(team)) {
        body = (
          <>
            <p class="hint">
              {who(e.player)}: {gi.teams[team]}'s device records their actions. Here: block, steal or assist.
            </p>
            <div class="grid4">
              <button {...send({ kind: 'block' })}>BLK</button>
              <button {...send({ kind: 'steal' })}>STL</button>
              <button {...send({ kind: 'assist' })}>AST</button>
              <button {...send({ kind: 'skip' })}>Cancel</button>
            </div>
          </>
        );
        break;
      }
      body = (
        <>
          <p class="hint">{who(e.player)}</p>
          <div class="grid4">
            <button class="make" {...send({ kind: 'shot', value: 2, made: true })}>2 ✓</button>
            <button class="miss" {...send({ kind: 'shot', value: 2, made: false })}>2 ✗</button>
            <button class="make" {...send({ kind: 'shot', value: 3, made: true })}>3 ✓</button>
            <button class="miss" {...send({ kind: 'shot', value: 3, made: false })}>3 ✗</button>
          </div>
          {gi.shotLocations && <Court />}
          <div class="grid4">
            <button {...send({ kind: 'rebound' })}>REB</button>
            <button {...send({ kind: 'assist' })}>AST</button>
            <button {...send({ kind: 'steal' })}>STL</button>
            <button {...send({ kind: 'block' })}>BLK</button>
            <button {...send({ kind: 'turnover' })}>TO</button>
            <button {...send({ kind: 'foul' })}>FOUL</button>
            <button {...send({ kind: 'sub' })}>SUB</button>
            <button {...send({ kind: 'skip' })}>Cancel</button>
          </div>
        </>
      );
      break;
    }
    case 'shotResult':
      body = (
        <>
          <p class="hint">
            {who(e.player)} · {e.value}PT <button class="link" {...send({ kind: 'flipValue' })}>switch to {e.value === 2 ? 3 : 2}</button>
          </p>
          <div class="grid2">
            <button class="make" {...send({ kind: 'result', made: true })}>Made</button>
            <button class="miss" {...send({ kind: 'result', made: false })}>Missed</button>
          </div>
        </>
      );
      break;
    case 'assist':
      body = <Prompt text="Assist? Tap the passer." />;
      break;
    case 'rebound':
      body = <Prompt text="Rebound? Tap the player or Team REB." />;
      break;
    case 'steal':
      body = <Prompt text="Steal? Tap the defender." />;
      break;
    case 'turnoverKind':
      body = (
        <>
          <p class="hint">Turnover type</p>
          <div class="grid3">
            {TURNOVERS.map(([k, label]) => (
              <button key={k} {...send({ kind: 'turnoverKind', value: k })}>{label}</button>
            ))}
            <button {...send({ kind: 'skip' })}>Other</button>
          </div>
        </>
      );
      break;
    case 'foulKind':
      body = (
        <>
          <p class="hint">{who(e.player)} · foul type</p>
          <div class="grid3">
            {FOUL_KINDS.map((k) => (
              <button key={k} {...send({ kind: 'foulKind', value: k })}>{k}</button>
            ))}
          </div>
        </>
      );
      break;
    case 'fouled':
      body = <Prompt text="Who was fouled? Tap the player." />;
      break;
    case 'ftCount':
      body = (
        <>
          <p class="hint">Free throws awarded</p>
          <div class="grid3">
            {([1, 2, 3] as const).map((n) => (
              <button key={n} {...send({ kind: 'ftCount', n })}>{n}</button>
            ))}
          </div>
        </>
      );
      break;
    case 'sub':
      body = (
        <>
          <p class="hint">Substitution {gi.teams[e.team]}: tap players going out and coming in</p>
          <p>Out: {e.out.map(who).join(', ') || '-'}</p>
          <p>In: {e.in.map(who).join(', ') || '-'}</p>
          <div class="grid2">
            <button class="primary" {...send({ kind: 'confirm' })}>Confirm</button>
            <button {...send({ kind: 'skip' })}>Cancel</button>
          </div>
        </>
      );
      break;
  }
  return (
    <section class="pad">
      {typed.value && <p class="typed">#{typed.value}</p>}
      <FreeThrows />
      {body}
    </section>
  );
}

function Prompt({ text }: { text: string }) {
  return (
    <div class="prompt">
      <p>{text}</p>
      <button {...send({ kind: 'skip' })}>Skip</button>
    </div>
  );
}

function FreeThrows() {
  const due = state.value.freeThrowQueue[0];
  if (!due) return null;
  const p = due.shooter ? playersById.value.get(due.shooter) : undefined;
  return (
    <div class="ft">
      <span>
        FT {due.next}/{due.of} · {p ? `#${p.jersey} ${p.name}` : `pick a ${info.value!.teams[due.team]} shooter`}
      </span>
      {can.value.team(due.team) ? (
        <>
          <button class="make" {...send({ kind: 'ft', made: true })} data-testid="ft-made">Made</button>
          <button class="miss" {...send({ kind: 'ft', made: false })} data-testid="ft-miss">Missed</button>
        </>
      ) : (
        <i class="small">{info.value!.teams[due.team]}'s device records these</i>
      )}
    </div>
  );
}

/** Half court, baseline at the bottom. Tap = shot location. */
function Court() {
  const onDown = (e: PointerEvent) => {
    const t = performance.now();
    e.preventDefault();
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    input({ kind: 'court', x: (e.clientX - r.left) / r.width, y: 1 - (e.clientY - r.top) / r.height });
    measureTap(t);
  };
  return (
    <svg class="court" viewBox="0 0 150 140" onPointerDown={onDown} data-testid="court">
      <rect x="0" y="0" width="150" height="140" class="floor" />
      <path d="M9 140 V110.1 A67.5 67.5 0 0 1 141 110.1 V140" class="line" />
      <rect x="50" y="82" width="50" height="58" class="line" />
      <circle cx="75" cy="124.25" r="2.25" class="line" />
    </svg>
  );
}

function Break() {
  const st = state.value;
  const lastEnd = [...events.value].reverse().find((e) => e.type === 'periodEnd');
  const checked = !!lastEnd && events.value.some((e) => e.type === 'checkpoint' && e.period === lastEnd.period);
  const a = useSignal(String(st.score.A));
  const b = useSignal(String(st.score.B));
  if (st.phase === 'final') {
    return (
      <section class="break">
        <h2>Final</h2>
        <p class="final">
          {info.value!.teams.A} {st.score.A} – {st.score.B} {info.value!.teams.B}
        </p>
      </section>
    );
  }
  const regulationOver = !!st.rules && st.period >= st.rules.periods;
  if (!can.value.control) {
    return (
      <section class="break">
        <h2>End of period {st.period}</h2>
        <p>Waiting for the game-control device to start the next period.</p>
      </section>
    );
  }
  return (
    <section class="break">
      <h2>End of period {st.period}</h2>
      {!checked ? (
        <>
          <p>Check the score against the official scoreboard.</p>
          <label>
            {info.value!.teams.A} <input value={a.value} onInput={(e) => (a.value = e.currentTarget.value)} inputMode="numeric" size={3} />
          </label>
          <label>
            {info.value!.teams.B} <input value={b.value} onInput={(e) => (b.value = e.currentTarget.value)} inputMode="numeric" size={3} />
          </label>
          <button class="primary" onClick={() => checkpoint({ A: Number(a.value), B: Number(b.value) })}>
            Confirm score
          </button>
          {(Number(a.value) !== st.score.A || Number(b.value) !== st.score.B) && <p class="error">Doesn't match the log ({st.score.A}–{st.score.B}). It will be flagged for review.</p>}
        </>
      ) : (
        <div class="grid2">
          <button class="primary" onClick={nextPeriod}>
            Start {regulationOver ? 'overtime' : `period ${st.period + 1}`}
          </button>
          {regulationOver && st.score.A !== st.score.B && <button onClick={endGame}>End game</button>}
        </div>
      )}
    </section>
  );
}

function PlayByPlay() {
  const selected = useSignal<string | null>(null);
  const list = [...events.value].reverse().filter((e) => !['roleClaim', 'roleRelease', 'roleTransfer'].includes(e.type));
  const actions = (e: GameEvent) => (
    <span class="row-actions">
      <button onClick={() => correct({ targetId: e.id }, 'void')}>Remove</button>
      {e.type === 'shot' && (
        <>
          <button onClick={() => correct({ targetId: e.id, body: { type: 'shot', payload: { ...e.payload, made: !e.payload.made, ...(e.payload.made ? { assist: undefined } : { block: undefined }) } } }, 'amend')}>
            {e.payload.made ? 'Mark missed' : 'Mark made'}
          </button>
          <button onClick={() => correct({ targetId: e.id, body: { type: 'shot', payload: { ...e.payload, value: e.payload.value === 2 ? 3 : 2 } } }, 'amend')}>
            Make it {e.payload.value === 2 ? 3 : 2}PT
          </button>
        </>
      )}
      {e.type === 'freeThrow' && (
        <button onClick={() => correct({ targetId: e.id, body: { type: 'freeThrow', payload: { ...e.payload, made: !e.payload.made } } }, 'amend')}>
          {e.payload.made ? 'Mark missed' : 'Mark made'}
        </button>
      )}
    </span>
  );
  return (
    <aside class="pbp" data-testid="pbp">
      {rejected.value.length > 0 && (
        <details open>
          <summary>{rejected.value.length} refused by the server (not counted)</summary>
          {rejected.value.map((r) => (
            <p key={r.event.id} class="error">
              {describe(r.event, playersById.value)}: {r.reason}
            </p>
          ))}
        </details>
      )}
      {list.map((e) => (
        <div key={e.id} class={e.seq === null ? 'row unsynced' : 'row'} onClick={() => (selected.value = selected.value === e.id ? null : e.id)}>
          <span class="t">
            P{e.period} {formatClock(e.gameClock)}
          </span>
          <span>{describe(e, playersById.value)}</span>
          {selected.value === e.id && !['amend', 'void', 'periodStart', 'gameStart'].includes(e.type) && actions(e)}
        </div>
      ))}
      <p class="small">Tap-to-render median: {median(tapToRender.value)} ms</p>
    </aside>
  );
}

/** Play-by-play text with '#jersey name' for players. */
const describe = (e: GameEvent, players: Map<string, Player>) =>
  describeEvent(e, (id) => {
    const p = id ? players.get(id) : undefined;
    return p ? `#${p.jersey} ${p.name}` : 'team';
  });

const median = (xs: number[]) => (xs.length ? Math.round([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!) : '-');


const KEYS: [string, string][] = [
  ['0-9 then Enter', 'pick player by jersey (Tab: other team)'],
  ['S / X', '2 made / missed'],
  ['D / C', '3 made / missed'],
  ['R V L B', 'rebound, assist, steal, block'],
  ['T / F / U', 'turnover / foul / substitution'],
  ['M / N', 'free throw made / missed'],
  ['Foul type', 'P personal, S shooting, O offensive, T technical, U unsportsmanlike, D disqualifying'],
  ['Turnover type', 'B bad pass, L lost ball, T travel, D double dribble, O out, C shot clock, K backcourt, F off. foul'],
  ['Shift+A / Shift+B', 'team rebound'],
  ['Space', 'start / stop clock'],
  ['Z', 'undo'],
  ['Esc / Enter', 'skip, cancel / confirm'],
];

function Help() {
  return (
    <aside class="help" onClick={() => (showHelp.value = false)}>
      <h2>Keyboard</h2>
      <dl>
        {KEYS.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p class="small">Press ? to close</p>
    </aside>
  );
}

/** Timeouts, possession arrow and jump ball: the game-control device only. */
function ControlBar() {
  const gi = info.value!;
  const arrow = state.value.arrow;
  const jump = (wonBy: Team) => {
    record({ type: 'jumpBall', payload: { wonBy } });
    record({ type: 'possessionArrow', payload: { team: wonBy === 'A' ? 'B' : 'A' } });
  };
  return (
    <div class="control-bar">
      <button {...send({ kind: 'timeout', team: 'A' })}>Timeout {gi.teams.A}</button>
      <button {...send({ kind: 'timeout', team: 'B' })}>Timeout {gi.teams.B}</button>
      <button {...tap(() => record({ type: 'possessionArrow', payload: { team: arrow === 'A' ? 'B' : 'A' } }))} data-testid="arrow">
        Arrow: {arrow ? gi.teams[arrow] : '-'}
      </button>
      <button {...tap(() => jump('A'))}>Jump won {gi.teams.A}</button>
      <button {...tap(() => jump('B'))}>Jump won {gi.teams.B}</button>
    </div>
  );
}

const ROLES: Role[] = ['teamA', 'teamB', 'clock'];

/** Who holds each role; claim a free one, take over a held one (at a stoppage), or release yours. */
function Roles() {
  const st = state.value;
  const stopped = !st.clock.running;
  return (
    <div class="roles">
      {ROLES.map((r) => {
        const holder = st.roles[r];
        const mine = holder === myDevice.value;
        return (
          <div key={r} class="role" data-testid={`role-${r}`}>
            <b>{roleName(r)}</b>
            <span>{mine ? 'you' : holder ? 'another device' : 'free'}</span>
            {!holder && <button onClick={() => claim(r)}>Claim</button>}
            {holder && !mine && (
              <button disabled={!stopped} title={stopped ? '' : 'Stop the clock first'} onClick={() => takeOver(r)}>
                Take over
              </button>
            )}
            {mine && <button onClick={() => release(r)}>Release</button>}
          </div>
        );
      })}
      {!stopped && <p class="small">Take-overs happen at a stoppage: stop the clock first.</p>}
    </div>
  );
}

function RolePicker() {
  return (
    <div class="pregame">
      <h1>Pick your role</h1>
      <p>Each role is scored on one device. Clock is optional: without it, {roleName('teamA')} runs the clock.</p>
      {notice.value && <p class="error">{notice.value}</p>}
      <Roles />
    </div>
  );
}
