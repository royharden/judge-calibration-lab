import { defineConfig } from 'vitest/config';

// Unit and contract suites live under tests/. src/core is pure TS, so the node
// environment is enough; UI tests (if any are added later) can opt into jsdom per file.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
});
