import { describe, expect, test } from 'vitest';
import { initials } from './avatar';

describe('initials', () => {
  test('first and last name', () => {
    expect(initials('Kwame Asante')).toBe('KA');
    expect(initials('Ama Serwaa Ofori')).toBe('AO');
  });
  test('one name, extra spaces, lower case', () => {
    expect(initials('Kojo')).toBe('K');
    expect(initials('  yaw   boateng ')).toBe('YB');
  });
  test('empty', () => {
    expect(initials('')).toBe('?');
  });
});
