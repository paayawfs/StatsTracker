import { FIBA, replay, type EventBody, type GameEvent, type GameState } from '@stats/core';
import { beforeEach, describe, expect, test } from 'vitest';
import { idle, step, type Entry, type Input } from './entry';

const A = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
const B = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'];

let n = 0;
let log: GameEvent[];
const stamp = (body: EventBody): GameEvent =>
  ({ id: `e${++n}`, gameId: 'g', seq: null, deviceId: 'd', deviceSeq: n, role: 'single', period: 1, gameClock: 600_000 - n, wallClock: n, ...body }) as GameEvent;

beforeEach(() => {
  n = 0;
  log = [
    stamp({ type: 'gameStart', payload: { rules: FIBA, shotLocations: false, roster: { A: A.map((playerId) => ({ playerId, jersey: '1' })), B: B.map((playerId) => ({ playerId, jersey: '1' })) } } }),
    stamp({ type: 'periodStart', payload: { lineups: { A: A.slice(0, 5), B: B.slice(0, 5) } } }),
  ];
});

/** Run inputs through the machine, appending emitted events to the log. */
function run(...inputs: Input[]): { entry: Entry; emitted: GameEvent[]; state: GameState } {
  let entry: Entry = idle;
  const emitted: GameEvent[] = [];
  for (const input of inputs) {
    const r = step(entry, input, { state: replay(log), events: log, stamp });
    entry = r.entry;
    emitted.push(...r.events);
    log.push(...r.events);
  }
  return { entry, emitted, state: replay(log) };
}
const bodies = (es: GameEvent[]) => es.map((e) => ({ type: e.type, payload: e.payload }));
const p = (id: string): Input => ({ kind: 'player', id });

describe('shots', () => {
  test('player then made 2 emits a shot and prompts for an assist', () => {
    const r = run(p('a1'), { kind: 'shot', value: 2, made: true });
    expect(bodies(r.emitted)).toEqual([{ type: 'shot', payload: { shooter: 'a1', value: 2, made: true } }]);
    expect(r.entry).toMatchObject({ step: 'assist' });
    expect(r.state.score.A).toBe(2);
  });

  test('assist prompt: tapping a teammate amends the shot', () => {
    const r = run(p('a1'), { kind: 'shot', value: 3, made: true }, p('a2'));
    expect(r.emitted[1]).toMatchObject({ type: 'amend', payload: { targetId: r.emitted[0]!.id, body: { type: 'shot', payload: { shooter: 'a1', value: 3, made: true, assist: 'a2' } } } });
    expect(r.entry).toEqual(idle);
  });

  test('assist prompt: skip emits nothing more', () => {
    const r = run(p('a1'), { kind: 'shot', value: 2, made: true }, { kind: 'skip' });
    expect(r.emitted).toHaveLength(1);
    expect(r.entry).toEqual(idle);
  });

  test('assist prompt: tapping an opponent starts a new selection instead', () => {
    const r = run(p('a1'), { kind: 'shot', value: 2, made: true }, p('b3'));
    expect(r.emitted).toHaveLength(1);
    expect(r.entry).toEqual({ step: 'player', player: 'b3' });
  });

  test('missed shot prompts for the rebound; kind is derived from teams', () => {
    const off = run(p('a1'), { kind: 'shot', value: 2, made: false }, p('a4'));
    expect(off.emitted[1]).toMatchObject({ type: 'rebound', payload: { team: 'A', player: 'a4', kind: 'offensive' } });
    const def = run(p('a1'), { kind: 'shot', value: 2, made: false }, p('b2'));
    expect(def.emitted.at(-1)).toMatchObject({ type: 'rebound', payload: { team: 'B', player: 'b2', kind: 'defensive' } });
  });

  test('team rebound from the rebound prompt', () => {
    const r = run(p('a1'), { kind: 'shot', value: 3, made: false }, { kind: 'team', team: 'B' });
    expect(r.emitted.at(-1)).toMatchObject({ type: 'rebound', payload: { team: 'B', kind: 'defensive' } });
    expect((r.emitted.at(-1)!.payload as { player?: string }).player).toBeUndefined();
  });

  test('court tap sets location and suggested value, then made/miss', () => {
    const r = run(p('a1'), { kind: 'court', x: 0.5, y: 0.9 }, { kind: 'result', made: false });
    expect(r.emitted[0]).toMatchObject({ type: 'shot', payload: { shooter: 'a1', value: 3, made: false, x: 0.5, y: 0.9 } });
  });

  test('tapping another section before Made/Missed moves the shot there', () => {
    const r = run(p('a1'), { kind: 'court', x: 0.5, y: 0.2 }, { kind: 'court', x: 0.5, y: 0.9 });
    expect(r.entry).toEqual({ step: 'shotResult', player: 'a1', x: 0.5, y: 0.9, value: 3 });
    expect(r.emitted).toEqual([]);
    const done = run(p('a1'), { kind: 'court', x: 0.5, y: 0.9 }, { kind: 'court', x: 0.5, y: 0.2 }, { kind: 'result', made: true });
    expect(done.emitted[0]).toMatchObject({ payload: { shooter: 'a1', value: 2, made: true, x: 0.5, y: 0.2 } });
  });

  test('court value can be flipped before the result', () => {
    const r = run(p('a1'), { kind: 'court', x: 0.5, y: 0.2 }, { kind: 'flipValue' }, { kind: 'result', made: true });
    expect(r.emitted[0]).toMatchObject({ payload: { value: 3 } });
  });

  test('block: defender then BLK amends the last missed opposing shot', () => {
    const r = run(p('a1'), { kind: 'shot', value: 2, made: false }, { kind: 'skip' }, p('b1'), { kind: 'block' });
    expect(r.emitted.at(-1)).toMatchObject({ type: 'amend', payload: { targetId: r.emitted[0]!.id, body: { payload: { block: 'b1' } } } });
  });

  test('block with no missed opposing shot does nothing', () => {
    const r = run(p('b1'), { kind: 'block' });
    expect(r.emitted).toHaveLength(0);
  });

  test('assist later: teammate then AST amends the last made shot', () => {
    const r = run(p('a1'), { kind: 'shot', value: 2, made: true }, { kind: 'skip' }, p('a3'), { kind: 'assist' });
    expect(r.emitted.at(-1)).toMatchObject({ type: 'amend', payload: { body: { payload: { assist: 'a3' } } } });
  });
});

describe('turnovers', () => {
  test('player, TO, kind, then steal prompt', () => {
    const r = run(p('a2'), { kind: 'turnover' }, { kind: 'turnoverKind', value: 'badPass' }, p('b4'));
    expect(bodies(r.emitted)[0]).toEqual({ type: 'turnover', payload: { team: 'A', player: 'a2', kind: 'badPass' } });
    expect(r.emitted[1]).toMatchObject({ type: 'amend', payload: { body: { payload: { steal: 'b4' } } } });
  });

  test('no steal prompt after a travel: the next tap selects a player', () => {
    const r = run(p('a1'), { kind: 'turnover' }, { kind: 'turnoverKind', value: 'travelling' }, p('b2'));
    expect(r.entry).toEqual({ step: 'player', player: 'b2' });
    expect(r.emitted.map((e) => e.type)).toEqual(['turnover']);
  });

  test('TO -> Off. foul records the offensive foul too, same as FOUL -> offensive', () => {
    const r = run(p('a1'), { kind: 'turnover' }, { kind: 'turnoverKind', value: 'offensiveFoul' });
    expect(bodies(r.emitted).map((b) => b.type)).toEqual(['foul', 'turnover']);
    expect(r.state.personalFouls.a1).toBe(1);
  });

  test('skipping the kind records "other"', () => {
    const r = run(p('a2'), { kind: 'turnover' }, { kind: 'skip' });
    expect(r.emitted[0]).toMatchObject({ payload: { kind: 'other' } });
    expect(r.entry).toMatchObject({ step: 'steal' });
  });

  test('team turnover', () => {
    const r = run({ kind: 'teamTurnover', team: 'B' }, { kind: 'turnoverKind', value: 'shotClock' });
    expect(bodies(r.emitted)).toEqual([{ type: 'turnover', payload: { team: 'B', kind: 'shotClock' } }]);
  });

  test('steal later: defender then STL amends the last opposing turnover', () => {
    const r = run(p('a2'), { kind: 'turnover' }, { kind: 'turnoverKind', value: 'badPass' }, { kind: 'skip' }, p('b5'), { kind: 'steal' });
    expect(r.emitted.at(-1)).toMatchObject({ type: 'amend', payload: { body: { payload: { steal: 'b5' } } } });
  });
});

describe('fouls', () => {
  test('personal foul outside the bonus: no free throws', () => {
    const r = run(p('b1'), { kind: 'foul' }, { kind: 'foulKind', value: 'personal' }, p('a1'));
    expect(bodies(r.emitted)).toEqual([{ type: 'foul', payload: { team: 'B', offender: 'player', player: 'b1', kind: 'personal', fouled: 'a1', freeThrows: 0 } }]);
    expect(r.entry).toEqual(idle);
  });

  test('personal foul in the bonus: 2 free throws queued automatically', () => {
    const foul = [p('b2'), { kind: 'foul' }, { kind: 'foulKind', value: 'personal' }, p('a1')] as Input[];
    const r = run(...foul, ...foul, ...foul, ...foul, ...foul);
    expect(r.emitted.at(-1)).toMatchObject({ payload: { freeThrows: 2 } });
    expect(r.state.freeThrowQueue).toEqual([{ team: 'A', shooter: 'a1', next: 1, of: 2 }]);
  });

  test('personal foul in the bonus with "who was fouled" skipped: free throws still queued', () => {
    const foul = [p('b2'), { kind: 'foul' }, { kind: 'foulKind', value: 'personal' }, { kind: 'skip' }] as Input[];
    const r = run(...foul, ...foul, ...foul, ...foul, ...foul);
    expect(r.state.freeThrowQueue).toEqual([{ team: 'A', shooter: null, next: 1, of: 2 }]);
    const ft = run(p('a3'), { kind: 'ft', made: true }, { kind: 'ft', made: true });
    expect(ft.emitted.map((e) => e.payload)).toMatchObject([{ shooter: 'a3', attempt: 1 }, { shooter: 'a3', attempt: 2 }]);
  });

  test('shooting foul asks for the count', () => {
    const r = run(p('b1'), { kind: 'foul' }, { kind: 'foulKind', value: 'shooting' }, p('a3'), { kind: 'ftCount', n: 3 });
    expect(r.emitted[0]).toMatchObject({ payload: { kind: 'shooting', fouled: 'a3', freeThrows: 3 } });
    expect(r.state.freeThrowQueue[0]).toMatchObject({ shooter: 'a3', of: 3 });
  });

  test('offensive foul also records an offensive-foul turnover', () => {
    const r = run(p('a1'), { kind: 'foul' }, { kind: 'foulKind', value: 'offensive' }, p('b1'));
    expect(bodies(r.emitted)).toEqual([
      { type: 'foul', payload: { team: 'A', offender: 'player', player: 'a1', kind: 'offensive', fouled: 'b1', freeThrows: 0 } },
      { type: 'turnover', payload: { team: 'A', player: 'a1', kind: 'offensiveFoul' } },
    ]);
  });

  test('player technical: rule-set free throws, no fouled player', () => {
    const r = run(p('a1'), { kind: 'foul' }, { kind: 'foulKind', value: 'technical' });
    expect(r.emitted[0]).toMatchObject({ payload: { kind: 'technical', freeThrows: 1 } });
    expect(r.state.freeThrowQueue).toEqual([{ team: 'B', shooter: null, next: 1, of: 1, deadBall: true }]);
  });

  test('coach technical', () => {
    const r = run({ kind: 'benchFoul', team: 'A', offender: 'coach' });
    expect(bodies(r.emitted)).toEqual([{ type: 'foul', payload: { team: 'A', offender: 'coach', kind: 'technical', freeThrows: 1 } }]);
  });
});

describe('free throws', () => {
  const shootingFoul = [p('b1'), { kind: 'foul' }, { kind: 'foulKind', value: 'shooting' }, p('a3'), { kind: 'ftCount', n: 2 }] as Input[];

  test('FT buttons shoot for the queued player in order', () => {
    const r = run(...shootingFoul, { kind: 'ft', made: true }, { kind: 'ft', made: true });
    expect(bodies(r.emitted.slice(1))).toEqual([
      { type: 'freeThrow', payload: { shooter: 'a3', made: true, attempt: 1, of: 2 } },
      { type: 'freeThrow', payload: { shooter: 'a3', made: true, attempt: 2, of: 2 } },
    ]);
    expect(r.state.score.A).toBe(2);
  });

  test('missed last free throw prompts for the rebound', () => {
    const r = run(...shootingFoul, { kind: 'ft', made: true }, { kind: 'ft', made: false });
    expect(r.entry).toMatchObject({ step: 'rebound', shooterTeam: 'A' });
  });

  test('missed technical free throw: no rebound prompt', () => {
    const tech = [p('a1'), { kind: 'foul' }, { kind: 'foulKind', value: 'technical' }] as Input[];
    expect(run(...tech, p('b2'), { kind: 'ft', made: false }).entry).toEqual(idle);
  });

  test('technical free throw needs a shooter picked first', () => {
    const tech = [p('a1'), { kind: 'foul' }, { kind: 'foulKind', value: 'technical' }] as Input[];
    expect(run(...tech, { kind: 'ft', made: true }).emitted).toHaveLength(1);
    const r = run(...tech, p('b2'), { kind: 'ft', made: true });
    expect(r.emitted.at(-1)).toMatchObject({ type: 'freeThrow', payload: { shooter: 'b2', attempt: 1, of: 1 } });
  });
});

describe('substitution', () => {
  test('multi-player sub in one event', () => {
    const r = run(p('a1'), { kind: 'sub' }, p('a2'), p('a6'), p('a7'), { kind: 'confirm' });
    expect(bodies(r.emitted)).toEqual([{ type: 'substitution', payload: { team: 'A', out: ['a1', 'a2'], in: ['a6', 'a7'] } }]);
    expect(r.state.onFloor.A).toEqual(['a3', 'a4', 'a5', 'a6', 'a7']);
  });

  test('tapping a selected player again deselects', () => {
    const r = run(p('a1'), { kind: 'sub' }, p('a6'), p('a6'), p('a7'), { kind: 'confirm' });
    expect(r.emitted[0]).toMatchObject({ payload: { out: ['a1'], in: ['a7'] } });
  });

  test('other team taps are ignored during a sub', () => {
    const r = run(p('a1'), { kind: 'sub' }, p('b6'), p('a6'), { kind: 'confirm' });
    expect(r.emitted[0]).toMatchObject({ payload: { team: 'A', out: ['a1'], in: ['a6'] } });
  });

  test('skip cancels without emitting', () => {
    expect(run(p('a1'), { kind: 'sub' }, p('a6'), { kind: 'skip' }).emitted).toEqual([]);
  });

  test('confirm needs as many in as out', () => {
    const r = run(p('a1'), { kind: 'sub' }, { kind: 'confirm' });
    expect(r.emitted).toEqual([]);
    expect(r.entry).toMatchObject({ step: 'sub', out: ['a1'], in: [] });
    expect(run(p('a1'), { kind: 'sub' }, p('a2'), p('a6'), { kind: 'confirm' }).emitted).toEqual([]);
  });
});

describe('selection', () => {
  test('tapping another player switches the selection', () => {
    expect(run(p('a1'), p('b2')).entry).toEqual({ step: 'player', player: 'b2' });
  });
  test('skip clears the selection', () => {
    expect(run(p('a1'), { kind: 'skip' }).entry).toEqual(idle);
  });
  test('an action with nobody selected does nothing', () => {
    expect(run({ kind: 'shot', value: 2, made: true }).emitted).toEqual([]);
  });
});

describe('team actions', () => {
  test('timeout', () => {
    expect(bodies(run({ kind: 'timeout', team: 'B' }).emitted)).toEqual([{ type: 'timeout', payload: { team: 'B' } }]);
  });

  test('no timeout once they are used up', () => {
    const t: Input = { kind: 'timeout', team: 'B' };
    expect(run(t, t, t).emitted.map((e) => e.type)).toEqual(['timeout', 'timeout']); // FIBA: 2 in the first half
  });

  test('the foul that reaches the limit opens the sub panel with that player going out', () => {
    const foul = [p('b2'), { kind: 'foul' }, { kind: 'foulKind', value: 'personal' }, { kind: 'skip' }] as Input[];
    const r = run(...foul, ...foul, ...foul, ...foul, ...foul);
    expect(r.entry).toEqual({ step: 'sub', team: 'B', out: ['b2'], in: [] });
  });

  test('timeout stops a running clock first', () => {
    log.push(stamp({ type: 'clockStart', payload: {} }));
    expect(run({ kind: 'timeout', team: 'B' }).emitted.map((e) => e.type)).toEqual(['clockStop', 'timeout']);
  });
});

describe('ownership (multi mode)', () => {
  // This device scores team A only; team B has its own device.
  type Can = { team: (t: string) => boolean; control: boolean };
  const teamA: Can = { team: (t) => t === 'A', control: false };
  function runAs(can: Can, ...inputs: Input[]) {
    let entry: Entry = idle;
    const emitted: GameEvent[] = [];
    for (const input of inputs) {
      const r = step(entry, input, { state: replay(log), events: log, stamp, can });
      entry = r.entry;
      emitted.push(...r.events);
      log.push(...r.events);
    }
    return { entry, emitted };
  }

  test('primary actions for the other team are not recorded', () => {
    expect(runAs(teamA, p('b1'), { kind: 'shot', value: 2, made: true }).emitted).toEqual([]);
    expect(runAs(teamA, p('b1'), { kind: 'foul' }).entry).toEqual({ step: 'player', player: 'b1' });
  });

  test('rebound prompt on the shooting team device accepts only its own rebounders', () => {
    const r = runAs(teamA, p('a1'), { kind: 'shot', value: 2, made: false }, p('b2'));
    expect(r.emitted).toHaveLength(1); // just the shot
    expect(r.entry).toEqual({ step: 'player', player: 'b2' });
    const off = runAs(teamA, p('a1'), { kind: 'shot', value: 2, made: false }, p('a3'));
    expect(off.emitted.at(-1)).toMatchObject({ type: 'rebound', payload: { team: 'A', kind: 'offensive' } });
  });

  test('secondary players still work: fouled opponent, steal, block', () => {
    const foul = runAs(teamA, p('a1'), { kind: 'foul' }, { kind: 'foulKind', value: 'personal' }, p('b1'));
    expect(foul.emitted[0]).toMatchObject({ type: 'foul', payload: { team: 'A', fouled: 'b1' } });
    const to = runAs(teamA, p('a2'), { kind: 'turnover' }, { kind: 'turnoverKind', value: 'badPass' }, p('b3'));
    expect(to.emitted[1]).toMatchObject({ type: 'amend', payload: { body: { payload: { steal: 'b3' } } } });
  });

  test('free throws only for teams this device owns', () => {
    // B's device records B's foul; the FT queue is for team A.
    const bDevice: Can = { team: (t) => t === 'B', control: false };
    runAs(bDevice, p('b1'), { kind: 'foul' }, { kind: 'foulKind', value: 'shooting' }, p('a1'), { kind: 'ftCount', n: 2 });
    expect(runAs(bDevice, { kind: 'ft', made: true }).emitted).toEqual([]);
    expect(runAs(teamA, { kind: 'ft', made: true }).emitted[0]).toMatchObject({ type: 'freeThrow', payload: { shooter: 'a1' } });
  });

  test('team actions respect ownership and game control', () => {
    expect(runAs(teamA, { kind: 'timeout', team: 'A' }).emitted).toEqual([]); // timeouts are game control
    expect(runAs({ ...teamA, control: true }, { kind: 'timeout', team: 'B' }).emitted).toHaveLength(1);
    expect(runAs(teamA, { kind: 'benchFoul', team: 'B', offender: 'coach' }).emitted).toEqual([]);
    expect(runAs(teamA, { kind: 'teamTurnover', team: 'B' }).entry).toEqual(idle);
  });
});
