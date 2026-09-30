import type { GameEvent } from '@stats/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, test, vi } from 'vitest';
import { SupabaseTransport, SupabaseViewerTransport } from './supabase';
import { NetworkError, Rejected } from './transport';

/** A fake client whose rpc() is awaitable and supports .abortSignal(), like postgrest's builder. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = (rpc: (...a: any[]) => Promise<unknown>) =>
  ({ rpc: (...a: unknown[]) => { const p = rpc(...a); return Object.assign(p, { abortSignal: () => p }); } }) as unknown as SupabaseClient;
const stub = (rpc: () => Promise<unknown>) => new SupabaseTransport(client(rpc), 'g');
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

  test('a request that never answers times out as a network error (retry later)', async () => {
    const t = new SupabaseTransport({
      rpc: () => {
        let answer: (v: unknown) => void = () => {};
        const p = new Promise((resolve) => (answer = resolve)); // never answers by itself
        const aborted = () => answer({ data: null, status: 0, error: { code: '', message: 'AbortError' } });
        return Object.assign(p, { abortSignal: (sig: AbortSignal) => (sig.aborted ? aborted() : sig.addEventListener('abort', aborted), p) });
      },
    } as unknown as SupabaseClient, 'g');
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort());
    await expect(t.persist(event)).rejects.toBeInstanceOf(NetworkError);
    timeout.mockRestore();
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
    const t = new SupabaseTransport(client(async (_: string, args: unknown) => {
      calls.push(args);
      return { data: pages.shift(), error: null, status: 200 };
    }), 'g');
    expect(await t.fetchSince(0)).toHaveLength(1001);
    expect(calls).toEqual([{ game: 'g', after_seq: 0 }, { game: 'g', after_seq: 1000 }]);
  });
});

describe('SupabaseViewerTransport (read-only)', () => {
  test('persist is always refused; nothing is ever broadcast', async () => {
    const calls: unknown[] = [];
    const t = new SupabaseViewerTransport(client(async (...a: unknown[]) => (calls.push(a), { data: [], error: null, status: 200 })), 'slug1');
    await expect(t.persist({} as GameEvent)).rejects.toBeInstanceOf(Rejected);
    t.broadcast({ kind: 'discard', eventId: 'x' });
    expect(calls).toEqual([]);
  });

  test('catch-up reads public_events by slug', async () => {
    const calls: unknown[] = [];
    const t = new SupabaseViewerTransport(client(async (fn: string, args: unknown) => (calls.push([fn, args]), { data: [], error: null, status: 200 })), 'slug1');
    await t.fetchSince(7);
    expect(calls).toEqual([['public_events', { slug: 'slug1', after_seq: 7 }]]);
  });
});
