import { defineConfig, devices } from '@playwright/test';

// Tests the production build (service worker included) against local Supabase.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure' },
  projects: [{ name: 'tablet', use: { ...devices['Desktop Chrome'], viewport: { width: 1180, height: 820 }, hasTouch: true } }],
  webServer: { command: 'pnpm build && pnpm preview --port 4173 --strictPort', port: 4173, reuseExistingServer: true, timeout: 180_000 },
});
