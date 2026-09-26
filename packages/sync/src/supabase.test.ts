import type { GameEvent } from '@stats/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, test } from 'vitest';
import { SupabaseTransport } from './supabase';
import { NetworkError, Rejected } from './transport';

const stub = (rpc: () => Promise<unknown>) => new SupabaseTransport({ rpc } as unknown as SupabaseClient, 'g');
const err = (status: number, code = 'X') => async () => ({ data: null, status, error: { code, message: `status ${status}` } });
const event = {} as GameEvent;

describe('SupabaseTransport error classification', () => {
  test.each([400, 403, 404, 409])('%i is a rejection (do not retry)', async (status) => {
    await expect(stub(err(status)).persist(event)).rejects.toBeInstanceOf(Rejected);
  });

  test.each([0, 401, 408, 429, 500, 503])('%i is a network error (retry)', async (status) => {
    await expect(stub(err(status)).persist(event)).rejects.toBeInstanceOf(NetworkError);
  });

  test('a thrown fetch is a network error', async () => {
    await expect(stub(async () => { throw new TypeError('fetch failed'); }).persist(event)).rejects.toBeInstanceOf(NetworkError);
  });

  test('rejection keeps the Postgres error code', async () => {
    await expect(stub(err(403, '42501')).persist(event)).rejects.toMatchObject({ code: '42501' });
  });

  test('fetchSince pages until a short page', async () => {
    const pages = [
      Array.from({ length: 1000 }, (_, i) => ({ seq: i + 1 })),
      [{ seq: 1001 }],
    ];
    const calls: unknown[] = [];
    const t = new SupabaseTransport({
      rpc: async (_: string, args: unknown) => {
        calls.push(args);
        return { data: pages.shift(), error: null, status: 200 };
      },
    } as unknown as SupabaseClient, 'g');
    expect(await t.fetchSince(0)).toHaveLength(1001);
    expect(calls).toEqual([{ game: 'g', after_seq: 0 }, { game: 'g', after_seq: 1000 }]);
  });
});
