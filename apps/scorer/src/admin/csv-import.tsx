import { useSignal } from '@preact/signals';
import { guessMapping, parseCsv, planImport, type Csv, type Mapping } from './csv';
import { importRoster, type PlayerRow, type TeamRow } from './data';

const FIELDS: [keyof Mapping, string][] = [
  ['name', 'Full name'],
  ['first', 'First name'],
  ['last', 'Last name'],
  ['jersey', 'Jersey'],
  ['team', 'Team'],
];

/** Upload or paste a roster CSV, map its columns, preview, import. */
export function CsvImport({ league, teams, players, done }: { league: string; teams: TeamRow[]; players: PlayerRow[]; done: () => void }) {
  const csv = useSignal<Csv | null>(null);
  const mapping = useSignal<Mapping | null>(null);
  const target = useSignal('');
  const paste = useSignal('');
  const status = useSignal('');
  const busy = useSignal(false);

  const load = (text: string) => {
    const parsed = parseCsv(text);
    if (!parsed.headers.length || !parsed.rows.length) {
      status.value = 'That file has no rows under the header. The first row must be column names.';
      return;
    }
    csv.value = parsed;
    mapping.value = guessMapping(parsed.headers);
    status.value = '';
  };
  const reset = () => ((csv.value = null), (mapping.value = null), (paste.value = ''));

  if (!csv.value || !mapping.value) {
    return (
      <>
      {status.value && <p class={status.value.startsWith('Added') ? 'ok' : 'error'}>{status.value}</p>}
      <details class="panel csv-import" open={!teams.length}>
        <summary>Import players from a CSV file</summary>
        <p class="small">First row = column names, e.g. <code>Name,Jersey,Team</code>. Commas, semicolons or tabs all work. You map the columns next.</p>
        <label for="csv-file">CSV file</label>
        <input id="csv-file" type="file" accept=".csv,text/csv,text/plain" onChange={async (e) => {
          const f = e.currentTarget.files?.[0];
          if (f) load(await f.text());
        }} />
        <label for="csv-paste">…or paste it here</label>
        <textarea id="csv-paste" rows={4} value={paste.value} onInput={(e) => (paste.value = e.currentTarget.value)} placeholder={'Name,Jersey,Team\nKofi Mensah,23,Lions'} />
        <button disabled={!paste.value.trim()} onClick={() => load(paste.value)}>Read pasted CSV</button>
      </details>
      </>
    );
  }

  const m = mapping.value;
  const set = (field: keyof Mapping, v: string) => (mapping.value = { ...m, [field]: v === '' ? null : Number(v) });
  const noName = m.name === null && m.first === null && m.last === null;
  const needsTarget = m.team === null;
  const plan = planImport(csv.value.rows, m, { teams, players, ...(target.value ? { targetTeam: target.value } : {}) });
  const count = (s: string) => plan.rows.filter((r) => r.status === s).length;
  const adds = count('add');

  return (
    <section class="panel csv-import">
      <h2>Map the columns <span class="small">{csv.value.rows.length} rows</span></h2>
      <div class="form-grid">
        {FIELDS.map(([field, label]) => (
          <>
            <label for={`map-${field}`}>{label}</label>
            <select id={`map-${field}`} value={m[field] ?? ''} onChange={(e) => set(field, e.currentTarget.value)}>
              <option value="">(not in file)</option>
              {csv.value!.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
            </select>
          </>
        ))}
        {needsTarget && (
          <>
            <label for="map-target">Add everyone to</label>
            <select id="map-target" value={target.value} onChange={(e) => (target.value = e.currentTarget.value)}>
              <option value="">Pick a team…</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </>
        )}
      </div>
      {noName && <p class="error">Map a name column: either Full name, or First and Last name.</p>}
      {m.name !== null && (m.first !== null || m.last !== null) && <p class="small">Full name is used; First/Last are ignored.</p>}

      <p data-testid="csv-summary">
        <b>{adds}</b> to add · {count('skip')} skipped · {count('error')} with problems
        {plan.newTeams.length > 0 && <> · new teams: <b>{plan.newTeams.join(', ')}</b></>}
      </p>
      <div class="scroll csv-preview">
        <table class="admin-table">
          <thead><tr><th>Name</th><th>Jersey</th><th>Team</th><th>Result</th></tr></thead>
          <tbody>
            {plan.rows.map((r, i) => (
              <tr key={i} class={`csv-${r.status}`}>
                <td>{r.name || '—'}</td><td>{r.jersey ?? ''}</td><td>{r.team || '—'}{r.team && !r.teamId && r.status === 'add' ? ' (new)' : ''}</td>
                <td>{r.status === 'add' ? 'add' : r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="row">
        <button class="primary" disabled={!adds || busy.value} onClick={async () => {
          busy.value = true;
          try {
            const n = await importRoster(league, plan);
            status.value = `Added ${n} players${plan.newTeams.length ? ` and ${plan.newTeams.length} new teams` : ''}.`;
            reset();
            done();
          } catch (e) {
            status.value = e instanceof Error ? e.message : String(e);
          } finally {
            busy.value = false;
          }
        }}>Import {adds} players</button>
        <button onClick={reset}>Cancel</button>
      </div>
      {status.value && <p>{status.value}</p>}
    </section>
  );
}
