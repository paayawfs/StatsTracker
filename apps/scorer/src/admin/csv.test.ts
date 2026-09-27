import { describe, expect, test } from 'vitest';
import { guessMapping, parseCsv, planImport } from './csv';

describe('parseCsv', () => {
  test('header + rows, quotes, commas inside quotes, doubled quotes, CRLF, blank lines', () => {
    const text = 'Name,Jersey,Team\r\n"Mensah, Kofi",23,Lions\r\n"Ama ""Ace"" Ofori",7,Tigers\r\n\r\nYaw,,Lions\r\n';
    expect(parseCsv(text)).toEqual({
      headers: ['Name', 'Jersey', 'Team'],
      rows: [
        ['Mensah, Kofi', '23', 'Lions'],
        ['Ama "Ace" Ofori', '7', 'Tigers'],
        ['Yaw', '', 'Lions'],
      ],
    });
  });

  test('semicolon and tab delimiters are detected', () => {
    expect(parseCsv('Name;No\nKofi;4').rows).toEqual([['Kofi', '4']]);
    expect(parseCsv('Name\tNo\nKofi\t4').rows).toEqual([['Kofi', '4']]);
  });

  test('a byte-order mark and surrounding spaces are removed', () => {
    expect(parseCsv('﻿ Name , No \n Kofi , 4 ').headers).toEqual(['Name', 'No']);
    expect(parseCsv('﻿Name,No\n Kofi , 4 ').rows).toEqual([['Kofi', '4']]);
  });

  test('short rows are padded, so every row has one cell per header', () => {
    expect(parseCsv('A,B,C\n1').rows).toEqual([['1', '', '']]);
  });
});

describe('guessMapping', () => {
  test('common header names', () => {
    expect(guessMapping(['Player Name', 'No.', 'Club'])).toEqual({ name: 0, first: null, last: null, jersey: 1, team: 2 });
    expect(guessMapping(['First name', 'Surname', 'Jersey #', 'Team'])).toEqual({ name: null, first: 0, last: 1, jersey: 2, team: 3 });
    expect(guessMapping(['#', 'Full name'])).toEqual({ name: 1, first: null, last: null, jersey: 0, team: null });
  });
  test('"Name" next to "Surname" is the first name', () => {
    expect(guessMapping(['Name', 'Surname', 'Jersey #', 'Team'])).toEqual({ name: null, first: 0, last: 1, jersey: 2, team: 3 });
  });

  test('unknown headers map to nothing', () => {
    expect(guessMapping(['Height', 'Position'])).toEqual({ name: null, first: null, last: null, jersey: null, team: null });
  });
});

describe('planImport', () => {
  const existingTeams = [{ id: 't1', name: 'Lions' }];
  const existingPlayers = [{ team_id: 't1', name: 'Kofi Mensah' }];

  test('rows go to matched or new teams; existing players are skipped', () => {
    const plan = planImport(
      [['Kofi Mensah', '23', 'lions'], ['Ama Ofori', '7', 'Tigers'], ['Yaw Boateng', '', 'Lions']],
      { name: 0, first: null, last: null, jersey: 1, team: 2 },
      { teams: existingTeams, players: existingPlayers },
    );
    expect(plan.newTeams).toEqual(['Tigers']);
    expect(plan.rows.map((r) => [r.name, r.team, r.jersey, r.status])).toEqual([
      ['Kofi Mensah', 'Lions', '23', 'skip'],
      ['Ama Ofori', 'Tigers', '7', 'add'],
      ['Yaw Boateng', 'Lions', null, 'add'],
    ]);
    expect(plan.rows[0]!.note).toBe('already on Lions');
  });

  test('first + last name columns', () => {
    const plan = planImport([['Kwame', 'Asante', '5']], { name: null, first: 0, last: 1, jersey: 2, team: null }, { teams: existingTeams, players: [], targetTeam: 't1' });
    expect(plan.rows[0]).toMatchObject({ name: 'Kwame Asante', team: 'Lions', teamId: 't1', status: 'add' });
  });

  test('without a team column everything goes to the chosen team', () => {
    const plan = planImport([['Esi', '11']], { name: 0, first: null, last: null, jersey: 1, team: null }, { teams: existingTeams, players: [], targetTeam: 't1' });
    expect(plan.rows[0]).toMatchObject({ teamId: 't1', status: 'add' });
  });

  test('problems are flagged, not imported', () => {
    const plan = planImport(
      [['', '4', 'Lions'], ['Abena', '123', 'Lions'], ['Efua', '9', ''], ['Adwoa', '9', 'Lions'], ['Akosua', '9', 'Lions'], ['Abena Kyei', '00', 'Lions'], ['Abena Kyei', '00', 'Lions']],
      { name: 0, first: null, last: null, jersey: 1, team: 2 },
      { teams: existingTeams, players: [] },
    );
    expect(plan.rows.map((r) => [r.status, r.note])).toEqual([
      ['error', 'no name'],
      ['error', 'jersey must be 0-99 or 00'],
      ['error', 'no team'],
      ['add', undefined],
      ['error', 'jersey 9 is already used on Lions in this file'],
      ['add', undefined],
      ['skip', 'duplicate row'],
    ]);
  });

  test('"#9" is jersey 9; a jersey already on the team is flagged', () => {
    const plan = planImport([['Esi', '#9'], ['Ama', '4']], { name: 0, first: null, last: null, jersey: 1, team: null }, { teams: existingTeams, players: [{ team_id: 't1', name: 'Kofi', default_jersey: '4' }], targetTeam: 't1' });
    expect(plan.rows.map((r) => [r.jersey, r.status])).toEqual([['9', 'add'], ['4', 'error']]);
  });

  test('no name mapping at all: every row is an error', () => {
    const plan = planImport([['x']], { name: null, first: null, last: null, jersey: null, team: null }, { teams: existingTeams, players: [], targetTeam: 't1' });
    expect(plan.rows[0]).toMatchObject({ status: 'error', note: 'no name' });
  });
});
