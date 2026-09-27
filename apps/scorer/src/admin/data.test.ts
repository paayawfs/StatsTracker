import { describe, expect, test } from 'vitest';
import { fillJerseys, newPlayersProblem, parsePlayers } from './data';

describe('parsePlayers (pasted roster lines)', () => {
  test('jersey then name, in common formats', () => {
    expect(parsePlayers('23 Kofi Mensah\n#7 Ama Ofori\n4. Yaw Boateng\n11 - Esi Quaye')).toEqual([
      { name: 'Kofi Mensah', default_jersey: '23' },
      { name: 'Ama Ofori', default_jersey: '7' },
      { name: 'Yaw Boateng', default_jersey: '4' },
      { name: 'Esi Quaye', default_jersey: '11' },
    ]);
  });
  test('names without numbers, blank lines and windows line endings', () => {
    expect(parsePlayers('Kwame Asante\r\n\r\n  Abena Kyei  ')).toEqual([
      { name: 'Kwame Asante', default_jersey: null },
      { name: 'Abena Kyei', default_jersey: null },
    ]);
  });
  test('a leading "00" or three-digit number is not a jersey', () => {
    expect(parsePlayers('#9 Kojo')).toEqual([{ name: 'Kojo', default_jersey: '9' }]);
    expect(parsePlayers('00 Kojo')).toEqual([{ name: 'Kojo', default_jersey: '00' }]);
    expect(parsePlayers('123 Street')).toEqual([{ name: '123 Street', default_jersey: null }]);
  });
});

describe('newPlayersProblem', () => {
  const team = [{ name: 'Kofi Mensah', default_jersey: '23' }];
  test('a clash with an existing jersey or player, or inside the paste', () => {
    expect(newPlayersProblem([{ name: 'Ama Ofori', default_jersey: '23' }], team)).toBe("#23 is already Kofi Mensah's number.");
    expect(newPlayersProblem([{ name: 'kofi  mensah', default_jersey: null }], team)).toBe('kofi  mensah is already on this team.');
    expect(newPlayersProblem([{ name: 'Yaw', default_jersey: '7' }, { name: 'Yaw', default_jersey: '8' }], [])).toBe('Yaw is already on this team.');
    expect(newPlayersProblem([{ name: 'A', default_jersey: '7' }, { name: 'B', default_jersey: '7' }], [])).toBe("#7 is already A's number.");
  });
  test('fine otherwise', () => {
    expect(newPlayersProblem([{ name: 'Ama Ofori', default_jersey: '7' }, { name: 'Esi', default_jersey: null }], team)).toBeNull();
  });
});

describe('fillJerseys', () => {
  test('missing and clashing numbers get the next free one, per team', () => {
    const r = fillJerseys([
      { team: 'A', jersey: '0' },
      { team: 'A', jersey: '7' },
      { team: 'A', jersey: '7' },
      { team: 'A', jersey: null },
      { team: 'B', jersey: '7' },
    ]);
    expect(r.map((x) => x.jersey)).toEqual(['0', '7', '1', '2', '7']);
  });
});
