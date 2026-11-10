// Runs every browser check in order against the dev server (start it first with `npm run dev`).
// Chrome is used from its default Windows path; set CHROME_PATH to use another.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
mkdirSync(new URL('./shots/', import.meta.url), { recursive: true });

const checks = [
  ['chain.mjs', ['50'], 'a full match played by a simulated phone through the real pages'],
  ['qa-host.mjs', [], 'game screens: axe, keyboard flow, edge cases'],
  ['qa-phone.mjs', [], 'phone pages and lobby: axe, states, edge cases'],
  ['qa-calib.mjs', [], 'spin calibration card: axe and layout'],
  ['calib.mjs', [], 'spin calibration flow, both hands, storage, gyro-less phone'],
  ['identity.mjs', [], 'players bound to phone ids, liveness, keyboard takeover'],
  ['rejoin.mjs', [], 'rejoin in a new tab, reload, null-clearing'],
];

let failed = 0;
for (const [file, args, what] of checks) {
  console.log(`\n=== ${file}: ${what}`);
  const r = spawnSync(process.execPath, [file, ...args], { cwd: here, stdio: 'inherit', timeout: 15 * 60_000 });
  if (r.status !== 0) { failed++; console.log(`=== ${file} exited with ${r.status ?? r.signal}`); }
}
console.log(`\n${checks.length - failed} of ${checks.length} scripts exited cleanly (read each script's PASS and FAIL lines above).`);
process.exit(failed ? 1 : 0);
