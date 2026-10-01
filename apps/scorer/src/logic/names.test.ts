import { describe, expect, test } from 'vitest';
import { chipLabels } from './names';

describe('chipLabels', () => {
  test('last names, with initials or full names only where teammates clash', () => {
    const labels = chipLabels([
      { id: '1', team: 'A', name: 'Kofi Mensah' },
      { id: '2', team: 'A', name: 'Ama Mensah' },
      { id: '3', team: 'A', name: 'Kwame Junior' },
      { id: '4', team: 'A', name: 'Kwabena Junior' },
      { id: '5', team: 'A', name: 'Yaw Boateng' },
      { id: '6', team: 'B', name: 'Esi Mensah' }, // other team: no clash
      { id: '7', team: 'A', name: 'Kojo' },
    ]);
    expect(Object.fromEntries(labels)).toEqual({
      1: 'K. Mensah', 2: 'A. Mensah', 3: 'Kwame Junior', 4: 'Kwabena Junior', 5: 'Boateng', 6: 'Mensah', 7: 'Kojo',
    });
  });
});
