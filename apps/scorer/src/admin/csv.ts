/** Roster import from CSV: parse, guess the column mapping, then plan what the import will do. */

export interface Csv {
  headers: string[];
  rows: string[][];
}

/**
 * RFC 4180-style parser: quoted fields, delimiters and newlines inside quotes, doubled quotes.
 * The delimiter (comma, semicolon or tab) is detected from the header line. Blank lines are
 * dropped, cells are trimmed, short rows are padded to the header width.
 */
export function parseCsv(input: string): Csv {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');

  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell), records.push(row), (row = []), (cell = '');
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), records.push(row);

  const clean = records.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
  const headers = clean[0] ?? [];
  const rows = clean.slice(1).map((r) => headers.map((_, i) => r[i] ?? ''));
  return { headers, rows };
}

export interface Mapping {
  /** Column index for a full name, or first + last. */
  name: number | null;
  first: number | null;
  last: number | null;
  jersey: number | null;
  team: number | null;
}

/** Guess the mapping from header names; anything unrecognised maps to nothing. */
export function guessMapping(headers: string[]): Mapping {
  const m: Mapping = { name: null, first: null, last: null, jersey: null, team: null };
  headers.forEach((raw, i) => {
    const h = raw.toLowerCase().trim();
    if (m.jersey === null && (/jersey|shirt|number/.test(h) || /^(#|no\.?|num)$/.test(h))) m.jersey = i;
    else if (m.first === null && /first|given|forename/.test(h)) m.first = i;
    else if (m.last === null && /last|surname|family/.test(h)) m.last = i;
    else if (m.team === null && /team|club/.test(h)) m.team = i;
    else if (m.name === null && /name|player/.test(h)) m.name = i;
  });
  // "Name, Surname": the plain name column is the first name.
  if (m.name !== null && m.last !== null && m.first === null) return { ...m, first: m.name, name: null };
  return m;
}

export interface PlanRow {
  name: string;
  jersey: string | null;
  /** Team name as it will appear (existing team's spelling when matched). */
  team: string;
  /** Existing team id; undefined for a team the import will create. */
  teamId?: string;
  status: 'add' | 'skip' | 'error';
  note?: string;
}

export interface ImportPlan {
  /** Teams in the file that don't exist yet, first spelling seen. */
  newTeams: string[];
  rows: PlanRow[];
}

/** What importing these rows would do. Nothing is written; errors and skips are explained per row. */
export function planImport(
  rows: string[][],
  m: Mapping,
  ctx: { teams: { id: string; name: string }[]; players: { team_id: string; name: string; default_jersey?: string | null }[]; targetTeam?: string },
): ImportPlan {
  const key = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const byName = new Map(ctx.teams.map((t) => [key(t.name), t]));
  const target = ctx.teams.find((t) => t.id === ctx.targetTeam);
  const newTeams = new Map<string, string>();
  const seen = new Set<string>();
  const jerseys = new Set<string>();
  const cell = (r: string[], i: number | null) => (i === null ? '' : (r[i] ?? '').trim());

  const out = rows.map((r): PlanRow => {
    const name = (m.name !== null ? cell(r, m.name) : [cell(r, m.first), cell(r, m.last)].filter(Boolean).join(' ')).replace(/\s+/g, ' ');
    const jerseyRaw = cell(r, m.jersey).replace(/^#\s*/, '');
    const teamRaw = m.team !== null ? cell(r, m.team) : (target?.name ?? '');
    const existing = teamRaw ? byName.get(key(teamRaw)) : undefined;
    const team = existing?.name ?? teamRaw;
    const row: PlanRow = { name, jersey: jerseyRaw || null, team, ...(existing ? { teamId: existing.id } : {}), status: 'add' };
    const fail = (note: string, status: 'error' | 'skip' = 'error') => ({ ...row, status, note });

    if (!name) return fail('no name');
    if (jerseyRaw && !/^\d{1,2}$/.test(jerseyRaw)) return fail('jersey must be 0-99 or 00');
    if (!teamRaw) return fail('no team');
    const person = `${key(team)}|${key(name)}`;
    if (seen.has(person)) return fail('duplicate row', 'skip');
    seen.add(person);
    if (existing && ctx.players.some((p) => p.team_id === existing.id && key(p.name) === key(name))) return fail(`already on ${team}`, 'skip');
    if (jerseyRaw) {
      const shirt = `${key(team)}|${jerseyRaw}`;
      if (jerseys.has(shirt)) return fail(`jersey ${jerseyRaw} is already used on ${team} in this file`);
      const holder = existing && ctx.players.find((p) => p.team_id === existing.id && p.default_jersey === jerseyRaw);
      if (holder) return fail(`#${jerseyRaw} is already ${holder.name}'s number on ${team}`);
      jerseys.add(shirt);
    }
    if (!existing && !newTeams.has(key(team))) newTeams.set(key(team), team);
    return row;
  });
  return { newTeams: [...newTeams.values()], rows: out };
}
