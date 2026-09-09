import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/workspace/src/tests/*.test.{ts,tsx}'],
    restoreMocks: true,
    clearMocks: true,
  },
});
