import { initialState, type GameState } from '@stats/core';
import { describe, expect, test } from 'vitest';
import { capabilities, heldRoles, ownerRole, roleFor } from './ownership';

const st = (roles: GameState['roles']): GameState => ({ ...initialState, roles, roster: { a1: 'A', b1: 'B' } });

describe('ownerRole mirrors the server rules', () => {
  const s = st({});
  test.each([
    [{ type: 'shot', payload: { shooter: 'a1', value: 2, made: true } }, 'teamA'],
    [{ type: 'freeThrow', payload: { shooter: 'b1', made: true, attempt: 1, of: 1 } }, 'teamB'],
    [{ type: 'rebound', payload: { team: 'B', kind: 'defensive' } }, 'teamB'],
    [{ type: 'turnover', payload: { team: 'A', kind: 'other' } }, 'teamA'],
    [{ type: 'foul', payload: { team: 'B', offender: 'coach', kind: 'technical', freeThrows: 1 } }, 'teamB'],
    [{ type: 'substitution', payload: { team: 'A', out: ['a1'], in: [] } }, 'teamA'],
    [{ type: 'timeout', payload: { team: 'B' } }, 'teamA'],
    [{ type: 'clockStart', payload: {} }, 'teamA'],
    [{ type: 'starters', payload: { lineups: { A: [], B: [] } } }, 'teamA'],
    [{ type: 'void', payload: { targetId: 'x' } }, 'any'],
    [{ type: 'checkpoint', payload: { score: { A: 0, B: 0 } } }, 'any'],
  ] as const)('%j -> %s', (body, owner) => {
    expect(ownerRole(body as never, s)).toBe(owner);
  });

  test('game control goes to the clock role once someone holds it', () => {
    expect(ownerRole({ type: 'timeout', payload: { team: 'A' } }, st({ clock: 'dev-c' }))).toBe('clock');
  });

  test('unknown shooter: any team role may write it', () => {
    expect(ownerRole({ type: 'shot', payload: { shooter: 'zz', value: 2, made: true } }, s)).toBe('any');
  });
});

describe('roles for this device', () => {
  const s = st({ teamA: 'me', clock: 'me', teamB: 'peer' });

  test('heldRoles', () => {
    expect(heldRoles(s, 'me').sort()).toEqual(['clock', 'teamA']);
  });

  test('roleFor picks the owning held role, or null', () => {
    expect(roleFor({ type: 'clockStart', payload: {} }, s, 'me')).toBe('clock');
    expect(roleFor({ type: 'rebound', payload: { team: 'A', kind: 'offensive' } }, s, 'me')).toBe('teamA');
    expect(roleFor({ type: 'rebound', payload: { team: 'B', kind: 'defensive' } }, s, 'me')).toBeNull();
    expect(roleFor({ type: 'void', payload: { targetId: 'x' } }, s, 'me')).not.toBeNull();
  });

  test('single mode holds everything', () => {
    expect(roleFor({ type: 'rebound', payload: { team: 'B', kind: 'defensive' } }, st({ single: 'me' }), 'me')).toBe('single');
  });

  test('capabilities', () => {
    const c = capabilities(s, 'me');
    expect(c.team('A')).toBe(true);
    expect(c.team('B')).toBe(false);
    expect(c.control).toBe(true);
    expect(capabilities(st({ teamB: 'me' }), 'me').control).toBe(false);
    expect(capabilities(st({ teamA: 'me' }), 'me').control).toBe(true); // no clock role: Team A
  });
});
