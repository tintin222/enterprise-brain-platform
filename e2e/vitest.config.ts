import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// End-to-end tests against the local stack: run `pnpm dev:up && pnpm dev:seed` first.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['**/*.e2e.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
