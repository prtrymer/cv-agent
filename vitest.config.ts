import { defineConfig } from 'vitest/config';

// Only the project's own tests. out/ holds generated material, including
// interview drills that run under `node --test`, not vitest.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
