import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/contract/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    pool: 'forks',
    fileParallelism: true,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
