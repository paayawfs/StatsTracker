import { describe, expect, test } from 'vitest';
import { parsePlayers } from './data';

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
    expect(parsePlayers('00 Kojo')).toEqual([{ name: 'Kojo', default_jersey: '00' }]);
    expect(parsePlayers('123 Street')).toEqual([{ name: '123 Street', default_jersey: null }]);
  });
});
