import { describe, expect, test } from 'vitest';
import { idle, type Entry } from './entry';
import { keyCommand, promptTeam, resolveJersey } from './keys';

const players = [
  { id: 'a4', jersey: '4', team: 'A' as const },
  { id: 'a12', jersey: '12', team: 'A' as const },
  { id: 'b4', jersey: '4', team: 'B' as const },
  { id: 'b9', jersey: '9', team: 'B' as const },
];
const onFloor = { A: ['a4', 'a12'], B: ['b4', 'b9'] };
const k = (key: string, entry: Entry = { step: 'player', player: 'a4' }, shiftKey = false) => keyCommand({ key, shiftKey }, entry);

describe('keyCommand', () => {
  test('global keys', () => {
    expect(k(' ', idle)).toEqual({ do: 'clock' });
    expect(k('z', idle)).toEqual({ do: 'undo' });
    expect(k('?', idle)).toEqual({ do: 'help' });
    expect(k('Escape')).toEqual({ input: { kind: 'skip' } });
  });

  test('digits build a jersey number', () => {
    expect(k('7', idle)).toEqual({ digit: '7' });
    expect(k('Enter', idle)).toEqual({ do: 'commit' });
    expect(k('Tab', idle)).toEqual({ do: 'switchTeam' });
  });

  test('shot and action letters with a player selected', () => {
    expect(k('s')).toEqual({ input: { kind: 'shot', value: 2, made: true } });
    expect(k('x')).toEqual({ input: { kind: 'shot', value: 2, made: false } });
    expect(k('d')).toEqual({ input: { kind: 'shot', value: 3, made: true } });
    expect(k('c')).toEqual({ input: { kind: 'shot', value: 3, made: false } });
    expect(k('r')).toEqual({ input: { kind: 'rebound' } });
    expect(k('f')).toEqual({ input: { kind: 'foul' } });
    expect(k('u')).toEqual({ input: { kind: 'sub' } });
  });

  test('free throws', () => {
    expect(k('m', idle)).toEqual({ input: { kind: 'ft', made: true } });
    expect(k('n', idle)).toEqual({ input: { kind: 'ft', made: false } });
  });

  test('picker steps reuse letters for their options', () => {
    const foulKind: Entry = { step: 'foulKind', team: 'A', player: 'a4' };
    expect(k('s', foulKind)).toEqual({ input: { kind: 'foulKind', value: 'shooting' } });
    expect(k('p', foulKind)).toEqual({ input: { kind: 'foulKind', value: 'personal' } });
    expect(k('o', foulKind)).toEqual({ input: { kind: 'foulKind', value: 'offensive' } });
    const toKind: Entry = { step: 'turnoverKind', team: 'A', player: 'a4' };
    expect(k('b', toKind)).toEqual({ input: { kind: 'turnoverKind', value: 'badPass' } });
    expect(k('t', toKind)).toEqual({ input: { kind: 'turnoverKind', value: 'travelling' } });
    const ftCount: Entry = { step: 'ftCount', foul: { team: 'B', player: 'b4', kind: 'shooting', fouled: 'a4' } };
    expect(k('2', ftCount)).toEqual({ input: { kind: 'ftCount', n: 2 } });
    const shotResult: Entry = { step: 'shotResult', player: 'a4', x: 0.5, y: 0.5, value: 2 };
    expect(k('m', shotResult)).toEqual({ input: { kind: 'result', made: true } });
    expect(k('Tab', shotResult)).toEqual({ input: { kind: 'flipValue' } });
  });

  test('Enter confirms a substitution', () => {
    expect(k('Enter', { step: 'sub', team: 'A', out: [], in: [] })).toEqual({ do: 'commitOrConfirm' });
  });

  test('team rebound with shift in the rebound prompt', () => {
    expect(k('A', { step: 'rebound', shooterTeam: 'A' }, true)).toEqual({ input: { kind: 'team', team: 'A' } });
  });

  test('unknown keys do nothing', () => {
    expect(k('F5')).toBeNull();
  });
});

describe('resolveJersey', () => {
  test('unique on-floor jersey', () => {
    expect(resolveJersey('12', 'A', players, onFloor, false)).toBe('a12');
    expect(resolveJersey('9', 'A', players, onFloor, false)).toBe('b9');
  });
  test('shared jersey goes to the preferred team', () => {
    expect(resolveJersey('4', 'A', players, onFloor, false)).toBe('a4');
    expect(resolveJersey('4', 'B', players, onFloor, false)).toBe('b4');
  });
  test('bench players only count during a substitution', () => {
    const floor = { A: ['a4'], B: ['b4'] };
    expect(resolveJersey('12', 'A', players, floor, false)).toBeUndefined();
    expect(resolveJersey('12', 'A', players, floor, true)).toBe('a12');
  });
});

describe('promptTeam', () => {
  const teamOf = (id: string) => (id.startsWith('a') ? 'A' : 'B') as 'A' | 'B';
  test('fouled player and stealer are on the other team; passer on the shooter team', () => {
    expect(promptTeam({ step: 'fouled', foul: { team: 'B', player: 'b4', kind: 'shooting' } }, teamOf, 'B')).toBe('A');
    expect(promptTeam({ step: 'assist', shot: { payload: { shooter: 'b9' } } } as never, teamOf, 'A')).toBe('B');
    expect(promptTeam({ step: 'steal', turnover: { payload: { team: 'A' } } } as never, teamOf, 'A')).toBe('B');
    expect(promptTeam(idle, teamOf, 'B')).toBe('B');
  });
});
