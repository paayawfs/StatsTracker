import { render } from 'preact';
import { createClient } from '@supabase/supabase-js';
import { supabaseClientOptions } from '@stats/sync';

export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:54321', import.meta.env.VITE_SUPABASE_ANON_KEY ?? '', supabaseClientOptions);

render(<p>Scorer</p>, document.getElementById('app')!);
