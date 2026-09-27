import { computed, signal } from '@preact/signals';
import { boxScore, initialState, lineups, onOff, playByPlay, shotChart, type GameEvent, type GameState, type RuleSet, type Team } from '@stats/core';
import { GameSync, LocalStore, SupabaseViewerTransport } from '@stats/sync';
import { createClient } from '@supabase/supabase-js';

const LOCAL_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const supabase = createClient(import.meta.env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:54321', import.meta.env.VITE_SUPABASE_ANON_KEY ?? LOCAL_ANON, {
  auth: { persistSession: false },
});

export interface PublicGame {
  gameId: string;
  teams: Record<Team, string>;
  rules: RuleSet;
  shotLocations: boolean;
  locked: boolean;
  roster: { playerId: string; name: string; jersey: string; team: Team }[];
}

export const game = signal<PublicGame | 'missing' | null>(null);
export const events = signal<readonly GameEvent[]>([]);
export const state = signal<GameState>(initialState);
export const online = signal(false);
export const now = signal(Date.now());

const players = computed(() => new Map((game.value && game.value !== 'missing' ? game.value.roster : []).map((p) => [p.playerId, p])));
export const who = (id?: string) => {
  const p = id ? players.value.get(id) : undefined;
  return p ? `#${p.jersey} ${p.name}` : 'Team';
};

// Derived stats are computed lazily: only the tab on screen reads (and so recomputes) its own.
export const box = computed(() => boxScore(events.value));
export const units = computed(() => lineups(events.value));
export const splits = computed(() => onOff(events.value));
export const shots = computed(() => shotChart(events.value));
export const plays = computed(() => playByPlay(events.value, who).reverse());

/** Load a game by its public slug and follow it live. Read-only: viewers never write. */
export async function open(slug: string) {
  const { data, error } = await supabase.rpc('public_game', { slug });
  if (error || !data) {
    game.value = 'missing';
    return;
  }
  const g = data as PublicGame;
  const sync = await GameSync.open({
    gameId: g.gameId,
    deviceId: `viewer-${crypto.randomUUID()}`,
    transport: new SupabaseViewerTransport(supabase, slug),
    store: await LocalStore.open('stats-viewer'),
    pollMs: 30_000, // many viewers: poll less than scorers do
  });
  const refresh = () => {
    events.value = sync.log.events.slice(); // GameLog mutates one array; a new one notifies signals
    state.value = sync.log.state;
    online.value = sync.online;
  };
  sync.onChange = refresh;
  setInterval(() => {
    online.value = sync.online;
    if (state.value.clock.running) now.value = sync.now();
  }, 200);
  game.value = g;
  refresh();
}
