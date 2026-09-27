/// <reference types="vitest/config" />
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [preact()],
  build: { target: 'es2022', sourcemap: true },
  test: { include: ['src/**/*.test.ts'], passWithNoTests: true },
});
