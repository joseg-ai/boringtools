import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/**/*.test.ts',
      'apps/diagnostics/**/*.test.ts',
      'apps/workspace/src/tests/*.test.{ts,tsx}',
      'tests/fixtures/integration/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 10_000,
    restoreMocks: true,
    clearMocks: true,
  },
});
