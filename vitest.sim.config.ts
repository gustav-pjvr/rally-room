import { defineConfig } from 'vitest/config';

// `npm run sim`: the player simulator's report (scripts/sim/report.sim.ts). Not part of `npm run verify`.
export default defineConfig({
  test: { include: ['scripts/sim/**/*.sim.ts'], testTimeout: 60 * 60_000, disableConsoleIntercept: true },
});
