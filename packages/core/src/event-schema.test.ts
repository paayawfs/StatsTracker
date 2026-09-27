/// <reference types="node" />
import { toJsonSchema } from '@valibot/to-json-schema';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { EventSchema } from './events';

// The server validates event JSON against a JSON Schema generated from EventSchema, so the two
// can never drift. Migrations are immutable: a schema change is a new migration, written by
// `pnpm db:event-schema` (vitest --mode write-schema).
const dir = new URL('../../../supabase/migrations/', import.meta.url);
const json = JSON.stringify(toJsonSchema(EventSchema, { errorMode: 'ignore' }));
const sql = `-- Generated from packages/core/src/events.ts by \`pnpm db:event-schema\`. Do not edit.
create or replace function public.event_json_schema() returns json
language sql immutable parallel safe as $schema$ select '${json.replaceAll("'", "''")}'::json $schema$;
`;

test('newest event schema migration matches EventSchema', () => {
  const latest = readdirSync(dir).filter((f) => f.endsWith('_event_schema.sql')).sort().at(-1);
  const current = latest && readFileSync(new URL(latest, dir), 'utf8');
  if ((import.meta as unknown as { env: { MODE: string } }).env.MODE === 'write-schema' && current !== sql) {
    // Always after the newest existing migration, even one named ahead of this clock.
    const now = Number(new Date().toISOString().replace(/\D/g, '').slice(0, 14));
    const newest = Math.max(...readdirSync(dir).map((f) => Number(f.slice(0, 14))).filter(Number.isFinite));
    const stamp = String(Math.max(now, newest + 1));
    writeFileSync(new URL(`${stamp}_event_schema.sql`, dir), sql);
    return;
  }
  expect(current, 'EventSchema changed: run `pnpm db:event-schema`').toBe(sql);
});
