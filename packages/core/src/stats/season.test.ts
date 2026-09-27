import { describe, expect, test } from 'vitest';
import { ev, gameStart, periodStart } from '../test-helpers';
import { eventsCsv, seasonTotals, summarize } from './season';

// Two games between the same clubs; "Lions" are team A in game 1 and team B in game 2.
const game1 = () => [
  gameStart(),
  periodStart(),
  ev('shot', { shooter: 'a1', value: 3, made: true }, { gameClock: 500_000 }),
  ev('shot', { shooter: 'b1', value: 2, made: true }, { gameClock: 400_000 }),
  ev('periodEnd', {}, { gameClock: 0 }),
  ev('gameEnd', {}, { gameClock: 0 }),
];
const game2 = () => [
  gameStart(),
  periodStart(),
  // Same player ids, but now the Lions' players are team B (b1..) — use a1 as the Tigers' player here.
  ev('shot', { shooter: 'b1', value: 2, made: true }, { gameClock: 500_000 }),
  ev('shot', { shooter: 'a1', value: 2, made: true }, { gameClock: 450_000 }),
  ev('shot', { shooter: 'a1', value: 2, made: true }, { gameClock: 400_000 }),
  ev('periodEnd', {}, { gameClock: 0 }),
  ev('gameEnd', {}, { gameClock: 0 }),
];

describe('seasonTotals', () => {
  const season = seasonTotals([
    { gameId: 'g1', teams: { A: 'lions', B: 'tigers' }, events: game1() },
    { gameId: 'g2', teams: { A: 'tigers', B: 'lions' }, events: game2() },
  ]);
  const p = (id: string) => season.players.find((x) => x.playerId === id)!;
  const t = (id: string) => season.teams.find((x) => x.teamId === id)!;

  test('player totals and games played across games', () => {
    expect(p('a1')).toMatchObject({ gp: 2, pts: 7, fgm: 3, fga: 3 });
    expect(p('b1')).toMatchObject({ gp: 2, pts: 4 });
  });

  test('per-game averages', () => {
    expect(p('a1').perGame.pts).toBe(3.5);
    expect(p('b1').perGame.pts).toBe(2);
  });

  test('a player who never got on the floor has no games played', () => {
    expect(p('a8')).toMatchObject({ gp: 0, pts: 0 });
    expect(p('a8').perGame.pts).toBe(0);
  });

  test('team records follow the real team, whichever side it was', () => {
    // g1: lions (A) 3 - 2 tigers. g2: tigers (A) 4 - 2 lions (B).
    expect(t('lions')).toMatchObject({ gp: 2, wins: 1, losses: 1, pts: 5, ptsAgainst: 6 });
    expect(t('tigers')).toMatchObject({ gp: 2, wins: 1, losses: 1, pts: 6, ptsAgainst: 5 });
  });

  test('unfinished games count as played but not as a win or loss', () => {
    const live = seasonTotals([{ gameId: 'g3', teams: { A: 'lions', B: 'tigers' }, events: game1().slice(0, 3) }]);
    expect(live.teams.find((x) => x.teamId === 'lions')).toMatchObject({ gp: 1, wins: 0, losses: 0, pts: 3 });
  });

  test('scheduled games that never started are not counted', () => {
    expect(seasonTotals([{ gameId: 'g4', teams: { A: 'lions', B: 'tigers' }, events: [] }]).teams).toEqual([]);
  });
});

describe('eventsCsv', () => {
  test('header, one row per event, payload as escaped JSON', () => {
    const e = ev('turnover', { team: 'A', player: 'a1', kind: 'badPass' }, { id: 'x1', seq: 7, gameClock: 90_000, wallClock: 5 });
    const csv = eventsCsv([e]).split('\r\n');
    expect(csv[0]).toBe('seq,id,period,gameClock,type,role,deviceId,deviceSeq,wallClock,payload');
    expect(csv[1]).toBe(`7,x1,1,90000,turnover,single,d1,${e.deviceSeq},5,"{""team"":""A"",""player"":""a1"",""kind"":""badPass""}"`);
  });

  test('unconfirmed events have an empty seq', () => {
    expect(eventsCsv([ev('clockStart', {}, { seq: null })]).split('\r\n')[1]!.startsWith(',')).toBe(true);
  });
});

describe('summarize', () => {
  test('median, p95 and max', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(summarize(xs)).toEqual({ n: 100, p50: 51, p95: 96, max: 100 });
  });
  test('empty', () => {
    expect(summarize([])).toEqual({ n: 0, p50: null, p95: null, max: null });
  });
});
