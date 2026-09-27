/// <reference types="vitest/config" />
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [preact()],
  build: { target: 'es2022', sourcemap: true },
  // Unit tests only; e2e/ is Playwright's.
  test: { include: ['src/**/*.test.ts'] },
});
