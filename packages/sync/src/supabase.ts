import type { GameEvent } from '@stats/core';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { NetworkError, Rejected, type PeerMessage, type SyncTransport, type TransportHandlers } from './transport';

/** Pass to createClient for scorer devices: a short heartbeat keeps cellular radios awake. */
export const supabaseClientOptions = { realtime: { heartbeatIntervalMs: 5000 } };

/** PostgREST returns 1000 rows at most by default; fetch in pages until a short page. */
const PAGE = 1000;

/**
 * Fast path: Realtime Broadcast on the private `game:<id>` channel. Durable path: the
 * `insert_event` RPC; the database broadcasts the durable copy on the same channel.
 */
export class SupabaseTransport implements SyncTransport {
  private channel?: RealtimeChannel;

  constructor(
    private readonly client: SupabaseClient,
    private readonly gameId: string,
  ) {}

  connect(h: TransportHandlers) {
    this.channel = this.client
      .channel(`game:${this.gameId}`, { config: { private: true, broadcast: { self: false } } })
      .on('broadcast', { event: 'event' }, ({ payload }) => h.onEvent(payload))
      .on('broadcast', { event: 'discard' }, ({ payload }) => {
        if (typeof payload?.eventId === 'string') h.onDiscard(payload.eventId);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') h.onStatus('online');
        else h.onStatus('offline'); // CHANNEL_ERROR, TIMED_OUT, CLOSED; realtime-js rejoins itself
      });
  }

  broadcast(m: PeerMessage) {
    // Not joined yet (or reconnecting): skip. The durable path delivers the event anyway, and
    // realtime-js would otherwise fall back to one REST request per event.
    if (this.channel?.state !== 'joined') return;
    const payload = m.kind === 'event' ? m.event : { eventId: m.eventId };
    void this.channel?.send({ type: 'broadcast', event: m.kind, payload }).catch(() => {});
  }

  async persist(event: GameEvent): Promise<number> {
    return Number(await this.call('insert_event', { event }));
  }

  async fetchSince(afterSeq: number): Promise<GameEvent[]> {
    const all: GameEvent[] = [];
    for (let after = afterSeq; ; ) {
      const page = (await this.call('game_events', { game: this.gameId, after_seq: after })) as GameEvent[];
      all.push(...page);
      if (page.length < PAGE) return all;
      after = page[page.length - 1]!.seq!;
    }
  }

  async serverTime(): Promise<number> {
    return Number(await this.call('server_now', {}));
  }

  close() {
    if (this.channel) void this.client.removeChannel(this.channel);
  }

  /**
   * 4xx (except 401/408/429) means the server refused the request: `Rejected`, don't retry.
   * Anything else (no response, 5xx, expired token) is a `NetworkError`: retry later.
   */
  private async call(fn: string, args: object): Promise<unknown> {
    let res;
    try {
      res = await this.client.rpc(fn, args);
    } catch (err) {
      throw new NetworkError(String(err));
    }
    if (!res.error) return res.data;
    const refused = res.status >= 400 && res.status < 500 && ![401, 408, 429].includes(res.status);
    if (refused) throw new Rejected(res.error.code, res.error.message);
    throw new NetworkError(`${res.status} ${res.error.message}`);
  }
}
