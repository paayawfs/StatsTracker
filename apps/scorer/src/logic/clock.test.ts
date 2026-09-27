import { describe, expect, test } from 'vitest';
import { formatClock, remaining } from './clock';

describe('remaining', () => {
  test('stopped clock shows its stored time', () => {
    expect(remaining({ running: false, gameClock: 300_000, wallClock: 0 }, 99_999)).toBe(300_000);
  });
  test('running clock counts down from the start wall time', () => {
    expect(remaining({ running: true, gameClock: 300_000, wallClock: 1_000 }, 11_000)).toBe(290_000);
  });
  test('never below zero', () => {
    expect(remaining({ running: true, gameClock: 1_000, wallClock: 0 }, 5_000)).toBe(0);
  });
});

describe('formatClock', () => {
  test('minutes and seconds above one minute', () => {
    expect(formatClock(600_000)).toBe('10:00');
    expect(formatClock(61_999)).toBe('1:01');
  });
  test('tenths in the last minute', () => {
    expect(formatClock(59_900)).toBe('59.9');
    expect(formatClock(4_250)).toBe('4.2');
    expect(formatClock(0)).toBe('0.0');
  });
});
