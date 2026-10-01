import { GameLog, type GameEvent, type PlayBody } from '@stats/core';
import { describe, expect, test } from 'vitest';
import { undoLast } from './undo';

let n = 0;
// Separate taps, a second apart (one tap's events are 1 ms apart).
const ev = (body: PlayBody | { type: 'amend' | 'void' | 'roleClaim'; payload: object }, deviceId = 'me', wallClock = ++n * 1000): GameEvent =>
  ({ id: `e${++n}`, gameId: 'g', seq: n, deviceId, deviceSeq: n, role: 'single', period: 1, gameClock: 600_000 - n, wallClock, ...body }) as GameEvent;
const log = (...es: GameEvent[]) => {
  const g = new GameLog();
  for (const e of es) g.add(e);
  return g;
};
const shot = { type: 'shot', payload: { shooter: 'a1', value: 2, made: true } } as const;

describe('undoLast', () => {
  test('voids my most recent event', () => {
    const s = ev(shot);
    expect(undoLast(log(s), 'me')).toEqual({ undoes: [s.id], bodies: [{ type: 'void', payload: { targetId: s.id } }] });
  });

  test('ignores other devices and session events', () => {
    const mine = ev(shot);
    const g = log(mine, ev(shot, 'peer'), ev({ type: 'roleClaim', payload: { role: 'single' } }));
    expect(undoLast(g, 'me')?.undoes).toEqual([mine.id]);
  });

  test('undoing a correction restores the previous version of its target', () => {
    const s = ev(shot);
    const a = ev({ type: 'amend', payload: { targetId: s.id, body: { type: 'shot', payload: { ...shot.payload, value: 3 } } } });
    expect(undoLast(log(s, a), 'me')).toEqual({ undoes: [a.id], bodies: [{ type: 'amend', payload: { targetId: s.id, body: shot } }] });
  });

  test('a shot and its assist are one action: one undo removes the shot', () => {
    const s = ev(shot);
    const a = ev({ type: 'amend', payload: { targetId: s.id, body: { type: 'shot', payload: { ...shot.payload, assist: 'a2' } } } });
    expect(undoLast(log(s, a), 'me')).toEqual({ undoes: [a.id, s.id], bodies: [{ type: 'void', payload: { targetId: s.id } }] });
  });

  test("a block on another phone's shot: undo takes off just the block", () => {
    const miss = { type: 'shot', payload: { shooter: 'a1', value: 2, made: false } } as const;
    const s = ev(miss, 'peer');
    const b = ev({ type: 'amend', payload: { targetId: s.id, body: { type: 'shot', payload: { ...miss.payload, block: 'b2' } } } });
    expect(undoLast(log(s, b), 'me')).toEqual({ undoes: [b.id], bodies: [{ type: 'amend', payload: { targetId: s.id, body: miss } }] });
  });

  test("one tap's events are one action (offensive foul + turnover)", () => {
    const before = ev(shot);
    const foul = ev({ type: 'foul', payload: { team: 'A', offender: 'player', player: 'a1', kind: 'offensive', freeThrows: 0 } }, 'me', 50_000);
    const to = ev({ type: 'turnover', payload: { team: 'A', player: 'a1', kind: 'offensiveFoul' } }, 'me', 50_001);
    expect(undoLast(log(before, foul, to), 'me')?.undoes).toEqual([foul.id, to.id]);
  });

  test('undoing a void restores the voided event', () => {
    const s = ev(shot);
    const v = ev({ type: 'void', payload: { targetId: s.id } });
    expect(undoLast(log(s, v), 'me')?.bodies).toEqual([{ type: 'amend', payload: { targetId: s.id, body: shot } }]);
  });

  test('repeated undo walks back past what was already undone', () => {
    const first = ev(shot);
    const s = ev(shot);
    const assist = ev({ type: 'amend', payload: { targetId: s.id, body: { type: 'shot', payload: { ...shot.payload, assist: 'a2' } } } });
    const g = log(first, s, assist);
    const u = undoLast(g, 'me')!;
    const markers = u.bodies.map((b) => ev(b));
    for (const m of markers) g.add(m);
    const second = undoLast(g, 'me', new Set([...u.undoes, ...markers.map((m) => m.id)]));
    expect(second).toEqual({ undoes: [first.id], bodies: [{ type: 'void', payload: { targetId: first.id } }] });
  });

  test('nothing to undo', () => {
    expect(undoLast(log(), 'me')).toBeNull();
  });
});
