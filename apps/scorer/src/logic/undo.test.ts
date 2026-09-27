import { GameLog, type GameEvent, type PlayBody } from '@stats/core';
import { describe, expect, test } from 'vitest';
import { undoLast } from './undo';

let n = 0;
const ev = (body: PlayBody | { type: 'amend' | 'void' | 'roleClaim'; payload: object }, deviceId = 'me'): GameEvent =>
  ({ id: `e${++n}`, gameId: 'g', seq: n, deviceId, deviceSeq: n, role: 'single', period: 1, gameClock: 600_000 - n, wallClock: n, ...body }) as GameEvent;
const log = (...es: GameEvent[]) => {
  const g = new GameLog();
  for (const e of es) g.add(e);
  return g;
};
const shot = { type: 'shot', payload: { shooter: 'a1', value: 2, made: true } } as const;

describe('undoLast', () => {
  test('voids my most recent event', () => {
    const s = ev(shot);
    expect(undoLast(log(s), 'me')).toEqual({ undoes: s.id, body: { type: 'void', payload: { targetId: s.id } } });
  });

  test('ignores other devices and session events', () => {
    const mine = ev(shot);
    const g = log(mine, ev(shot, 'peer'), ev({ type: 'roleClaim', payload: { role: 'single' } }));
    expect(undoLast(g, 'me')?.undoes).toBe(mine.id);
  });

  test('undoing an amend restores the previous version of its target', () => {
    const s = ev(shot);
    const a = ev({ type: 'amend', payload: { targetId: s.id, body: { type: 'shot', payload: { ...shot.payload, assist: 'a2' } } } });
    expect(undoLast(log(s, a), 'me')).toEqual({ undoes: a.id, body: { type: 'amend', payload: { targetId: s.id, body: shot } } });
  });

  test('undoing a void restores the voided event', () => {
    const s = ev(shot);
    const v = ev({ type: 'void', payload: { targetId: s.id } });
    expect(undoLast(log(s, v), 'me')?.body).toEqual({ type: 'amend', payload: { targetId: s.id, body: shot } });
  });

  test('repeated undo walks back past what was already undone', () => {
    const s = ev(shot);
    const assist = ev({ type: 'amend', payload: { targetId: s.id, body: { type: 'shot', payload: { ...shot.payload, assist: 'a2' } } } });
    const g = log(s, assist);
    const first = undoLast(g, 'me')!;
    const marker = ev(first.body);
    g.add(marker);
    const second = undoLast(g, 'me', new Set([first.undoes, marker.id]));
    expect(second).toEqual({ undoes: s.id, body: { type: 'void', payload: { targetId: s.id } } });
  });

  test('nothing to undo', () => {
    expect(undoLast(log(), 'me')).toBeNull();
  });
});
