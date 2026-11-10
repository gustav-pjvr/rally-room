// `npm run test:worker`: the relay conformance suite against the Worker under local wrangler dev.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['tests/relay/worker.suite.ts'],
    testTimeout: 20_000,
    hookTimeout: 120_000,
  },
});
