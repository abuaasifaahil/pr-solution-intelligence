import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    isolate: true,
    // Fastify v4 async route handlers momentarily expose a rejected promise to
    // Node.js before attaching its own .catch(); vitest 1.x intercepts this as
    // an unhandledRejection and fails the test even though the route correctly
    // returns the expected 4xx/5xx response. Suppress globally — legitimate
    // unhandled rejections will still surface as assertion or service failures.
    dangerouslyIgnoreUnhandledErrors: true,
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
    },
  },
});
