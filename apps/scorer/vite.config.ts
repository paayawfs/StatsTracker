/// <reference types="vitest/config" />
import preact from '@preact/preset-vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Without these a Vercel build would quietly talk to local Supabase (127.0.0.1).
  const env = loadEnv(mode, process.cwd());
  for (const k of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_PUBLIC_URL']) if (process.env.VERCEL && !env[k]) throw new Error(`${k} is not set in Vercel`);
  return {
    plugins: [preact()],
    build: { target: 'es2022', sourcemap: true },
    // Unit tests only; e2e/ is Playwright's.
    test: { include: ['src/**/*.test.ts'] },
  };
});
