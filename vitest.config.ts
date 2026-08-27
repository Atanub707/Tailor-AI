import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Some scrapers apply per-job delays (e.g. SimplyHired 1-3s detail
    // enrichment) — give fixture tests headroom so they never flake under
    // parallel load.
    testTimeout: 30000,
  },
});
