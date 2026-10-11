import { defineConfig } from 'vitest/config';

// Unit tests only: no services needed. End-to-end tests live in e2e/ (pnpm test:e2e).
export default defineConfig({
  test: {
    projects: ['packages/*', 'scripts'],
    passWithNoTests: true,
  },
});
