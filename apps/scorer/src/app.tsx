import { computed, useComputed, useSignal } from '@preact/signals';
import { describe as describeEvent, formatClock, FOUL_KINDS, remaining, shotZone, teamFoulCount, timeoutsAllowed, ZONES, type EventOf, type GameEvent, type Role, type Team } from '@stats/core';
import { Avatar, Court, snapToSection, toScreen } from '@stats/ui';
import type { ComponentChildren, JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import type { Input } from './logic/entry';
import { chipLabels } from './logic/names';
import {
  can, checkpoint, claim, clockNow, correct, endGame, endPeriod, entry, events, info, input, join, leave, measureTap, myDevice, myRoles, nextPeriod, notice, now, online, record, release, roleName, takeOver,
  pending, playersById, rejected, resume, setClock, showHelp, startGame, state, tapToRender, toggleClock, typed, undo, type Player,
} from './session';

/** The same button tapped again, with no other tap between, this soon: a double tap, not a second action. */
const DOUBLE_TAP_MS = 300;
let lastTap: { target: EventTarget | null; t: number } = { target: null, t: -Infinity };

/** Fire on pointerdown (not click) and record tap-to-render. */
const tap = (fn: () => void) => ({
  onPointerDown: (e: PointerEvent) => {
    const t = performance.now();
    e.preventDefault();
    if (e.currentTarget === lastTap.target && t - lastTap.t < DOUBLE_TAP_MS) return;
    lastTap = { target: e.currentTarget, t };
    fn();
    measureTap(t);
  },
  onClick: (e: MouseEvent) => e.detail === 0 && fn(), // keyboard or screen reader
});
const send = (i: Input) => tap(() => input(i));
const other = (t: Team): Team => (t === 'A' ? 'B' : 'A');
const chipNames = computed(() => chipLabels(info.value?.players ?? []));

export function App() {
  const ready = useSignal(false);
  useEffect(() => {
    void resume().finally(() => (ready.value = true));
  }, []);
  if (!ready.value) return null;
  if (!info.value) return <Join />;
  if (info.value.mode === 'multi' && !myRoles.value.length) return <RolePicker />;
  if (info.value.mode === 'single' && !myRoles.value.length && state.value.roles.single) return <TakeOverScoring />;
  if (state.value.phase === 'pregame') return <Pregame />;
  return <Live />;
}

// ---- before the game ---------------------------------------------------------------------------

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
      error.value = !navigator.onLine || (err instanceof TypeError && /fetch/i.test(err.message)) ? 'No connection. Joining needs internet once; after that scoring works offline.' : err instanceof Error ? err.message : String(err);
    } finally {
      busy.value = false;
    }
  };
  return (
    <form class="sheet join" onSubmit={submit}>
      <p class="eyebrow">Scorer</p>
      <h1>Join a game</h1>
      <label for="code">Game code</label>
      <input id="code" class="code-input" value={code.value} onInput={(e) => (code.value = e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))} autoFocus autocomplete="off" placeholder="8 characters" />
      <button class="primary big" disabled={busy.value || code.value.length < 8}>{busy.value ? 'Joining…' : 'Join game'}</button>
      {error.value && <p class="error">{error.value}</p>}
      <p class="small">The league admin gives you the code. No account needed.</p>
    </form>
  );
}

function Pregame() {
  const gi = info.value!;
  // Picks are recorded as they're made, so a phone that takes over control carries on with them.
  const starters = state.value.starters;
  const toggle = (p: Player) => {
    const list = starters[p.team];
    record({ type: 'starters', payload: { lineups: { ...starters, [p.team]: list.includes(p.id) ? list.filter((id) => id !== p.id) : [...list, p.id] } } });
  };
  const ok = starters.A.length === 5 && starters.B.length === 5;
  if (!can.value.control) {
    return (
      <div class="sheet wide">
        <p class="eyebrow">You score {myRoles.value.map(roleName).join(' and ')}</p>
        <h1>Waiting for the game to start</h1>
        <p>The {state.value.roles.clock ? 'Clock' : roleName('teamA')} device picks the starters and starts the game.</p>
        <Roles />
      </div>
    );
  }
  return (
    <div class="sheet wide pregame">
      <p class="eyebrow">Before tip-off</p>
      <h1>Confirm starters</h1>
      <div class="pregame-teams">
        {(['A', 'B'] as const).map((t) => (
          <section key={t} class={`team-${t}`}>
            <h2>
              {gi.teams[t]} <span class={starters[t].length === 5 ? 'count ok' : 'count'}>{starters[t].length}/5</span>
            </h2>
            <div class="starter-grid">
              {gi.players.filter((p) => p.team === t).map((p) => {
                const on = starters[t].includes(p.id);
                return (
                  <button key={p.id} class={on ? 'starter on' : 'starter'} onClick={() => toggle(p)} data-testid={`starter-${p.jersey}-${t}`} aria-pressed={on}>
                    <Avatar name={p.name} photo={p.photo} team={t} size={40} />
                    <b class="num">{p.jersey}</b>
                    <span class="pname">{p.name}</span>
                    {on && <i class="check" aria-hidden="true">✓</i>}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <button class="primary big" disabled={!ok} onClick={() => startGame(starters)}>
        {ok ? 'Start game' : `Pick 5 starters each (${starters.A.length}/5, ${starters.B.length}/5)`}
      </button>
    </div>
  );
}

// ---- live ---------------------------------------------------------------------------------------

function Live() {
  const phase = state.value.phase;
  const panel = useSignal<'none' | 'log' | 'roles' | 'menu'>('none');
  const toggle = (p: typeof panel.value) => (panel.value = panel.value === p ? 'none' : p);
  // Notices sit above the dock (never over the clock) and clear themselves.
  useEffect(() => {
    if (!notice.value) return;
    const t = setTimeout(() => (notice.value = null), 6000);
    return () => clearTimeout(t);
  }, [notice.value]);
  return (
    <div class="live">
      <Rail team="A" />
      <main class="center">
        <TopBar />
        <div class="stage">{phase === 'live' || (phase === 'break' && (entry.value.step !== 'idle' || state.value.freeThrowQueue.length)) ? <Stage /> : <Break />}</div>
      </main>
      <Rail team="B" />
      <Dock menu={() => toggle('menu')} />
      {notice.value && (
        <div class="toast" role="status" onClick={() => (notice.value = null)}>
          {notice.value}
        </div>
      )}
      {panel.value === 'menu' && <Menu close={() => (panel.value = 'none')} open={(p) => (panel.value = p)} />}
      {panel.value === 'log' && (
        <Drawer title="Play-by-play" close={() => (panel.value = 'none')}>
          <PlayByPlay />
        </Drawer>
      )}
      {panel.value === 'roles' && (
        <Drawer title="Roles" close={() => (panel.value = 'none')}>
          <Roles />
        </Drawer>
      )}
      {showHelp.value && <Help />}
    </div>
  );
}

function TopBar() {
  const clock = useComputed(() => formatClock(remaining(state.value.clock, now.value)));
  const st = state.value;
  return (
    <div class="topbar">
      <span class="period">{st.period > (st.rules?.periods ?? 4) ? `OT${st.period - (st.rules?.periods ?? 4)}` : `P${st.period}`}</span>
      <button class={st.clock.running ? 'clock running' : 'clock'} {...tap(toggleClock)} data-testid="clock" aria-label={st.clock.running ? 'Stop clock' : 'Start clock'}>
        {clock}
      </button>
      <span class={online.value ? 'net on' : 'net'}>
        {online.value ? 'online' : 'offline'}
        {pending.value ? ` · ${pending.value} to sync` : ''}
      </span>
      {can.value.control && <ClockAdjust />}
    </div>
  );
}

function ClockAdjust() {
  const open = useSignal(false);
  const value = useSignal('');
  if (!open.value) return <button class="link" onClick={() => ((open.value = true), (value.value = formatClock(clockNow())))}>set</button>;
  const apply = () => {
    const [m, s] = value.value.includes(':') ? value.value.split(':') : ['0', value.value];
    const ms = Math.round((Number(m) * 60 + Number(s)) * 1000);
    if (value.value.trim() && Number.isFinite(ms) && ms >= 0) setClock(ms);
    open.value = false;
  };
  return (
    <span class="clock-set">
      <input id="clock-set" aria-label="Game clock" value={value.value} onInput={(e) => (value.value = e.currentTarget.value)} size={5} />
      <button onClick={apply}>ok</button>
    </span>
  );
}

/** One team: score, jersey chips (on floor; whole roster during a sub), fouls/timeouts, team actions. */
function Rail({ team }: { team: Team }) {
  const gi = info.value!;
  const score = useComputed(() => state.value.score[team]);
  const lineup = useComputed(() => state.value.onFloor[team].join(','));
  const subbing = useComputed(() => entry.value.step === 'sub' && entry.value.team === team);
  const rebounding = useComputed(() => entry.value.step === 'rebound');
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
  const ids = subbing.value ? gi.players.filter((p) => p.team === team).map((p) => p.id) : lineup.value.split(',').filter(Boolean);
  const owns = can.value.team(team);
  const live = state.value.phase === 'live';
  const brk = state.value.phase === 'break';
  return (
    <section class={`rail team-${team}${subbing.value ? ' subbing' : ''}`}>
      <header>
        <span class="tname">{gi.teams[team]}</span>
        <b class="score" data-testid={`score-${team}`}>{score}</b>
      </header>
      <div class="chips">
        {ids.map((id) => (
          <Chip key={id} id={id} />
        ))}
      </div>
      <p class="meta">
        Fouls {fouls}
        {bonus.value && <b class="bonus">BONUS</b>} · Timeouts {timeouts}
      </p>
      {(live || brk) && (
        <div class="team-actions">
          {owns && rebounding.value && <button class="accent" {...send({ kind: 'team', team })}>Team REB</button>}
          {can.value.control && live && <button disabled={timeouts.value <= 0} {...send({ kind: 'timeout', team })} aria-label={`Timeout ${gi.teams[team]}`}>Timeout</button>}
          {owns && live && <button {...send({ kind: 'teamTurnover', team })}>Team TO</button>}
          {owns && <button {...send({ kind: 'benchFoul', team, offender: 'coach' })}>Coach T</button>}
          {owns && <button {...send({ kind: 'benchFoul', team, offender: 'bench' })}>Bench T</button>}
        </div>
      )}
    </section>
  );
}

function Chip({ id }: { id: string }) {
  const p = playersById.value.get(id);
  const fouls = useComputed(() => state.value.personalFouls[id] ?? 0);
  const cls = useComputed(() => {
    const e = entry.value;
    const onFloor = state.value.onFloor.A.includes(id) || state.value.onFloor.B.includes(id);
    const picked = (e.step === 'player' && e.player === id) || (e.step === 'sub' && (e.out.includes(id) || e.in.includes(id)));
    const out = !!state.value.rules && fouls.value >= state.value.rules.personalFoulLimit;
    return ['chip', picked && 'on', !onFloor && 'bench', out && 'fouled-out'].filter(Boolean).join(' ');
  });
  if (!p) return null;
  return (
    <button class={cls} {...send({ kind: 'player', id })} data-testid={`player-${p.team}-${p.jersey}`} aria-pressed={cls.value.includes(' on')}
      aria-label={`#${p.jersey} ${p.name}${fouls.value ? `, ${fouls.value} foul${fouls.value > 1 ? 's' : ''}` : ''}`}>
      <b>{p.jersey}</b>
      <span>{chipNames.value.get(id) ?? p.name}</span>
      {fouls.value > 0 && <i class="pf" aria-label={`${fouls.value} fouls`}>{'•'.repeat(fouls.value)}</i>}
    </button>
  );
}

const TURNOVERS = [
  ['badPass', 'Bad pass'], ['ballHandling', 'Lost ball'], ['travelling', 'Travel'], ['doubleDribble', 'Double dribble'],
  ['outOfBounds', 'Out of bounds'], ['threeSeconds', '3 sec'], ['fiveSeconds', '5 sec'], ['eightSeconds', '8 sec'],
  ['shotClock', 'Shot clock'], ['backcourt', 'Backcourt'], ['offensiveFoul', 'Off. foul'],
] as const;

const who = (id: string) => {
  const p = playersById.value.get(id);
  return p ? `#${p.jersey} ${p.name}` : '';
};

/** The centre: the court (or shot buttons), prompts, pickers and the substitution panel. */
function Stage() {
  const e = entry.value;
  const gi = info.value!;
  let overlay: JSX.Element | null = null;
  let hint: ComponentChildren = null;

  switch (e.step) {
    case 'idle':
      hint = state.value.clock.running || !can.value.control ? 'Tap a player' : 'Tap the clock to start it, then tap a player';
      break;
    case 'player': {
      const team = state.value.roster[e.player];
      hint =
        team && !can.value.team(team) ? (
          <>{who(e.player)} · scored on the {gi.teams[team]} phone</>
        ) : gi.shotLocations ? (
          <>{who(e.player)} · tap the section of the shot</>
        ) : (
          <>{who(e.player)}</>
        );
      break;
    }
    case 'shotResult':
      hint = <>{who(e.player)} · {ZONES.find((z) => z.id === shotZone(e.x, e.y))!.label}</>;
      break;
    case 'assist':
      overlay = <Prompt text="Assist? Tap the passer." />;
      break;
    case 'rebound':
      overlay = <Prompt text="Rebound? Tap the player or Team REB." />;
      break;
    case 'steal':
      overlay = <Prompt text="Steal? Tap the defender." />;
      break;
    case 'fouled':
      overlay = <Prompt text="Who was fouled? Tap the player." />;
      break;
    case 'turnoverKind':
      overlay = (
        <Picker title="Turnover type">
          {TURNOVERS.map(([k, label]) => (
            <button key={k} {...send({ kind: 'turnoverKind', value: k })}>{label}</button>
          ))}
          <button {...send({ kind: 'skip' })}>Other</button>
        </Picker>
      );
      break;
    case 'foulKind':
      overlay = (
        <Picker title={`${who(e.player)} · foul type`}>
          {FOUL_KINDS.map((k) => (
            <button key={k} {...send({ kind: 'foulKind', value: k })}>{k}</button>
          ))}
        </Picker>
      );
      break;
    case 'ftCount':
      overlay = (
        <Picker title="Free throws awarded" cols={3}>
          {([1, 2, 3] as const).map((n) => (
            <button key={n} class="big-num" {...send({ kind: 'ftCount', n })}>{n}</button>
          ))}
        </Picker>
      );
      break;
    case 'sub':
      overlay = (
        <div class="card sub-card">
          <p class="card-title">Substitution · {gi.teams[e.team]}</p>
          <p class="small">Tap players going out and coming in, in the {gi.teams[e.team]} rail.</p>
          {e.out.length !== e.in.length && <p class="small">{e.out.length} out, {e.in.length} in: pick as many coming in as going out.</p>}
          <div class="sub-lists">
            <div><span class="eyebrow">Out</span>{e.out.map((id) => <p key={id}>{who(id)}</p>)}</div>
            <div><span class="eyebrow">In</span>{e.in.map((id) => <p key={id}>{who(id)}</p>)}</div>
          </div>
          <div class="row">
            <button class="primary" disabled={!e.out.length || e.out.length !== e.in.length} {...send({ kind: 'confirm' })}>Confirm</button>
            <button {...send({ kind: 'skip' })}>Cancel</button>
          </div>
        </div>
      );
      break;
  }

  const selected = e.step === 'player' ? e.player : null;
  const ownsSelected = !!selected && can.value.team(state.value.roster[selected]!);
  return (
    <>
      <FreeThrows />
      {gi.shotLocations ? (
        <ShotCourt dim={!!overlay} active={ownsSelected || e.step === 'shotResult'} />
      ) : (
        <div class={`shot-grid${ownsSelected ? '' : ' idle'}`}>
          <ShotButtons disabled={!ownsSelected} />
        </div>
      )}
      {hint && <p class="stage-hint">{hint}</p>}
      {gi.shotLocations && ownsSelected && (
        <div class="no-spot">
          <span class="small">No spot:</span>
          <ShotButtons disabled={false} />
        </div>
      )}
      {typed.value && <p class="typed">#{typed.value}</p>}
      {overlay && <div class="overlay">{overlay}</div>}
    </>
  );
}

function ShotButtons({ disabled }: { disabled: boolean }) {
  return (
    <>
      <button class="make" disabled={disabled} {...send({ kind: 'shot', value: 2, made: true })}>2 ✓</button>
      <button class="miss" disabled={disabled} {...send({ kind: 'shot', value: 2, made: false })}>2 ✗</button>
      <button class="make" disabled={disabled} {...send({ kind: 'shot', value: 3, made: true })}>3 ✓</button>
      <button class="miss" disabled={disabled} {...send({ kind: 'shot', value: 3, made: false })}>3 ✗</button>
    </>
  );
}

/** The court with its 12 sections. Tap -> the section lights up and the Made/Missed card appears there. */
function ShotCourt({ dim, active }: { dim: boolean; active: boolean }) {
  const e = entry.value;
  const spot = e.step === 'shotResult' ? e : null;
  const at = spot ? toScreen(spot.x, spot.y) : null;
  const team = spot ? state.value.roster[spot.player] : undefined;
  return (
    <div class={`court-wrap${dim ? ' dim' : ''}${active ? ' active' : ''}`}>
      <Court
        testId="court"
        id="scorer-court"
        highlight={spot ? shotZone(spot.x, spot.y) : null}
        onTap={(x, y) => {
          const t = performance.now();
          const spot = snapToSection(x, y); // scorers pick a section, not an exact spot
          input({ kind: 'court', x: spot.x, y: spot.y });
          measureTap(t);
        }}
      >
        {at && <circle class={`court-spot team-${team}`} cx={at.sx} cy={at.sy} r="3.2" />}
      </Court>
      {spot && at && (
        <div class="result-card" style={{ left: `clamp(98px, ${(at.sx / 150) * 100}%, calc(100% - 98px))`, top: `clamp(48px, ${(at.sy / 140) * 100}%, calc(100% - 48px))` }}>
          <button class="make" {...send({ kind: 'result', made: true })}>
            <b>{spot.value}</b> Made
          </button>
          <button class="miss" {...send({ kind: 'result', made: false })}>
            <b>{spot.value}</b> Missed
          </button>
          <button class="link" {...send({ kind: 'flipValue' })}>switch to {spot.value === 2 ? 3 : 2}</button>
        </div>
      )}
    </div>
  );
}

function Prompt({ text }: { text: string }) {
  return (
    <div class="card prompt">
      <p class="card-title">{text}</p>
      <button {...send({ kind: 'skip' })}>Skip</button>
    </div>
  );
}

function Picker({ title, children, cols = 3 }: { title: string; children: ComponentChildren; cols?: number }) {
  return (
    <div class="card picker">
      <p class="card-title">{title}</p>
      <div class="picker-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {children}
      </div>
    </div>
  );
}

function FreeThrows() {
  const due = state.value.freeThrowQueue[0];
  if (!due) return null;
  const team = info.value!.teams[due.team];
  // Technical free throws have no fouled player: the scorer picks the shooter from that team.
  const e = entry.value;
  const picked = !due.shooter && e.step === 'player' && state.value.roster[e.player] === due.team ? e.player : undefined;
  const shooter = due.shooter ?? picked;
  const p = shooter ? playersById.value.get(shooter) : undefined;
  const owns = can.value.team(due.team);
  return (
    <div class={`ft-bar team-${due.team}`}>
      <span>
        {p ? (
          <>
            <b>FT {due.next}/{due.of}</b> · #{p.jersey} {p.name}
          </>
        ) : (
          <>
            <b>FT {due.next}/{due.of}</b>: tap the {team} shooter
          </>
        )}
      </span>
      {owns ? (
        <>
          <button class="make" disabled={!p} {...send({ kind: 'ft', made: true })} data-testid="ft-made">Made</button>
          <button class="miss" disabled={!p} {...send({ kind: 'ft', made: false })} data-testid="ft-miss">Missed</button>
        </>
      ) : (
        <i class="small">scored on the {team} phone</i>
      )}
    </div>
  );
}

/** Bottom dock: player actions (for the selected player), undo, and the menu. */
function Dock({ menu }: { menu: () => void }) {
  const e = entry.value;
  const selected = e.step === 'player' ? e.player : null;
  const team = selected ? state.value.roster[selected] : undefined;
  const owns = !!team && can.value.team(team);
  const live = state.value.phase === 'live';
  const brk = state.value.phase === 'break';
  const act = (label: string, i: Input, enabled: boolean) => (
    <button disabled={!enabled || !(live || (brk && (i.kind === 'foul' || i.kind === 'sub')))} {...send(i)}>
      {label}
    </button>
  );
  return (
    <nav class="dock">
      <div class="dock-actions">
        {act('REB', { kind: 'rebound' }, owns)}
        {act('AST', { kind: 'assist' }, owns)}
        {act('STL', { kind: 'steal' }, owns)}
        {act('BLK', { kind: 'block' }, owns)}
        {act('TO', { kind: 'turnover' }, owns)}
        {act('FOUL', { kind: 'foul' }, owns)}
        {act('SUB', { kind: 'sub' }, owns)}
        {selected && <button class="ghost" {...send({ kind: 'skip' })}>Cancel</button>}
      </div>
      <button class="undo" {...tap(undo)} data-testid="undo">
        Undo
      </button>
      <button class="more" onClick={menu} aria-label="More">☰</button>
    </nav>
  );
}

function Menu({ close, open }: { close: () => void; open: (p: 'log' | 'roles') => void }) {
  const gi = info.value!;
  const st = state.value;
  const control = can.value.control && st.phase === 'live';
  // Rule set setting: leagues without the alternating possession arrow (NBA-style) never see it.
  const arrow = st.rules?.possessionArrow !== false;
  const jump = (wonBy: Team) => {
    record({ type: 'jumpBall', payload: { wonBy } });
    if (arrow) record({ type: 'possessionArrow', payload: { team: other(wonBy) } });
  };
  const item = (label: string, fn: () => void, testId?: string) => (
    <button data-testid={testId} onClick={() => (close(), fn())}>
      {label}
    </button>
  );
  return (
    <div class="menu-scrim" onClick={close}>
      <div class="menu" onClick={(e) => e.stopPropagation()}>
        {item('Play-by-play', () => open('log'))}
        {gi.mode === 'multi' && item('Roles', () => open('roles'))}
        {control && item('End period', endPeriod)}
        {control && arrow && item(`Arrow → ${st.arrow === 'A' ? gi.teams.B : gi.teams.A}`, () => record({ type: 'possessionArrow', payload: { team: st.arrow === 'A' ? 'B' : 'A' } }), 'arrow')}
        {control && item(`Jump won ${gi.teams.A}`, () => jump('A'))}
        {control && item(`Jump won ${gi.teams.B}`, () => jump('B'))}
        {item('Keyboard shortcuts', () => (showHelp.value = true))}
        {item('Leave game', () => {
          const n = pending.value;
          // ponytail: native confirm; unsynced events stay on this device and sync when it rejoins.
          if (!n || confirm(`${n} event${n > 1 ? 's' : ''} not synced yet. They stay on this phone and sync when you rejoin this game. Leave anyway?`)) leave();
        }, 'leave')}
      </div>
    </div>
  );
}

function Drawer({ title, close, children }: { title: string; close: () => void; children: ComponentChildren }) {
  return (
    <aside class="drawer">
      <header>
        <h2>{title}</h2>
        <button onClick={close}>Close</button>
      </header>
      {children}
    </aside>
  );
}

/** "period 2", or "OT1" past regulation. */
const periodLabel = (st: { period: number; rules: { periods: number } | null }) =>
  st.rules && st.period > st.rules.periods ? `OT${st.period - st.rules.periods}` : `period ${st.period}`;

function Break() {
  const st = state.value;
  const lastEnd = [...events.value].reverse().find((e) => e.type === 'periodEnd');
  const checked = !!lastEnd && events.value.some((e) => e.type === 'checkpoint' && e.period === lastEnd.period);
  const a = useSignal(String(st.score.A));
  const b = useSignal(String(st.score.B));
  const gi = info.value!;
  if (st.phase === 'final') {
    return (
      <div class="card break">
        <p class="eyebrow">Final</p>
        <p class="final">
          {gi.teams.A} {st.score.A} – {st.score.B} {gi.teams.B}
        </p>
        <p class="small">Game over. The box score is live for fans; the league admin locks the game.</p>
        <button onClick={leave}>Done: leave game</button>
      </div>
    );
  }
  const regulationOver = !!st.rules && st.period >= st.rules.periods;
  if (!can.value.control) {
    return (
      <div class="card break">
        <h2>End of {periodLabel(st)}</h2>
        <p>Waiting for the {st.roles.clock ? 'Clock' : roleName('teamA')} phone to start the next period.</p>
      </div>
    );
  }
  return (
    <div class="card break">
      <h2>End of {periodLabel(st)}</h2>
      {!checked ? (
        <>
          <p>Check the score against the official scoreboard.</p>
          <div class="score-check">
            <label for="check-a">{gi.teams.A}</label>
            <input id="check-a" value={a.value} onInput={(e) => (a.value = e.currentTarget.value)} inputMode="numeric" size={3} />
            <label for="check-b">{gi.teams.B}</label>
            <input id="check-b" value={b.value} onInput={(e) => (b.value = e.currentTarget.value)} inputMode="numeric" size={3} />
          </div>
          {(Number(a.value) !== st.score.A || Number(b.value) !== st.score.B) && <p class="error">Doesn't match the log ({st.score.A}–{st.score.B}). It will be flagged for review.</p>}
          <button class="primary" onClick={() => checkpoint({ A: Number(a.value), B: Number(b.value) })}>
            Confirm score
          </button>
        </>
      ) : (
        <div class="row">
          {/* Not tied after regulation: the game is over, so End game is the main button. */}
          {regulationOver && st.score.A !== st.score.B && <button class="primary" onClick={endGame}>End game</button>}
          <button class={regulationOver && st.score.A !== st.score.B ? '' : 'primary'} onClick={nextPeriod}>
            Start {regulationOver ? 'overtime' : `period ${st.period + 1}`}
          </button>
        </div>
      )}
    </div>
  );
}

function PlayByPlay() {
  const selected = useSignal<string | null>(null);
  const list = [...events.value].reverse().filter((e) => !['roleClaim', 'roleRelease', 'roleTransfer', 'starters'].includes(e.type));
  const actions = (e: GameEvent) => (
    <span class="row-actions">
      <button onClick={() => correct({ targetId: e.id }, 'void')}>Remove</button>
      {e.type === 'shot' && (
        <>
          <button onClick={() => correct({ targetId: e.id, body: { type: 'shot', payload: { ...e.payload, made: !e.payload.made, ...(e.payload.made ? { assist: undefined } : { block: undefined }) } } }, 'amend')}>
            {e.payload.made ? 'Mark missed' : 'Mark made'}
          </button>
          <button onClick={() => correct({ targetId: e.id, body: { type: 'shot', payload: { ...withoutSpot(e.payload), value: e.payload.value === 2 ? 3 : 2 } } }, 'amend')}>
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
    <div class="pbp" data-testid="pbp">
      {rejected.value.length > 0 && (
        <details open class="refused">
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
    </div>
  );
}

/** Play-by-play text with '#jersey name' for players. */
const describe = (e: GameEvent, players: Map<string, Player>) =>
  describeEvent(e, (id) => {
    const p = id ? players.get(id) : undefined;
    return p ? `#${p.jersey} ${p.name}` : 'team';
  }, info.value?.teams);

/** A 2 made into a 3 can't keep a spot inside the arc (it would count as a 3 in the paint). */
const withoutSpot = ({ x: _x, y: _y, ...rest }: EventOf<'shot'>['payload']) => rest;

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
    <aside class="drawer help" onClick={() => (showHelp.value = false)}>
      <header>
        <h2>Keyboard</h2>
        <span class="small">Press ? to close</span>
      </header>
      <dl>
        {KEYS.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

const ROLES: Role[] = ['teamA', 'teamB', 'clock'];

/** Who holds each role; claim a free one, take over a held one (at a stoppage), or release yours. */
function Roles() {
  const st = state.value;
  const stopped = !st.clock.running;
  const control: Role = st.roles.clock ? 'clock' : 'teamA';
  return (
    <div class="roles">
      {ROLES.map((r) => {
        const holder = st.roles[r];
        const mine = holder === myDevice.value;
        return (
          <div key={r} class={`role${mine ? ' mine' : ''}`} data-testid={`role-${r}`}>
            <b>{roleName(r)}</b>
            <span>{mine ? 'you' : holder ? 'another device' : 'free'}</span>
            {!holder && <button class="primary" onClick={() => claim(r)}>Claim</button>}
            {holder && !mine && (
              <button disabled={!stopped && r !== control} title={stopped || r === control ? '' : 'Stop the clock first'} onClick={() => takeOver(r)}>
                Take over
              </button>
            )}
            {mine && <button onClick={() => release(r)}>Release</button>}
          </div>
        );
      })}
      {!stopped && <p class="small">Team phones are taken over at a stoppage. The {roleName(control)} phone runs the clock, so it can be taken over any time.</p>}
    </div>
  );
}

/** Single mode, joined on a second phone (e.g. the first one died): take over the scoring. */
function TakeOverScoring() {
  return (
    <div class="sheet">
      <p class="eyebrow">{info.value!.teams.A} v {info.value!.teams.B}</p>
      <h1>Another phone is scoring this game</h1>
      <p>If that phone died or you're replacing it, take over. It stops being able to score, and everything recorded so far stays.</p>
      <button class="primary big" onClick={() => takeOver('single')} data-testid="take-over-scoring">Take over scoring</button>
      <button onClick={leave}>Leave game</button>
    </div>
  );
}

function RolePicker() {
  return (
    <div class="sheet">
      <p class="eyebrow">Several devices</p>
      <h1>Pick your role</h1>
      <p>Each role is scored on one device. Clock is optional: without it, {roleName('teamA')} runs the clock.</p>
      {notice.value && <p class="error">{notice.value}</p>}
      <Roles />
    </div>
  );
}
