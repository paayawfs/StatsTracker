import { defineConfig, devices } from '@playwright/test';

// Scorer and viewer production builds side by side against local Supabase.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'viewer', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: 'pnpm --filter @stats/scorer build && pnpm --filter @stats/scorer preview --port 4173 --strictPort', port: 4173, reuseExistingServer: true, timeout: 180_000 },
    { command: 'pnpm build && pnpm preview --port 4174 --strictPort', port: 4174, reuseExistingServer: true, timeout: 180_000 },
  ],
});
