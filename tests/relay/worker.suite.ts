// The relay conformance suite against the Cloudflare Worker and its Durable Object, run locally by
// `wrangler dev` (workerd on this machine, no account, nothing deployed). Slow to start, so it has
// its own script: `npm run test:worker`.
//
// Each relay gets a temporary wrangler config outside the repo: the same Worker and object as
// worker/wrangler.jsonc, without the assets binding (the built site is not needed here), with the
// suite's short clocks as vars, and with its local state in the temporary folder.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relayConformance, type RelaySettings } from './conformance';

const root = fileURLToPath(new URL('../..', import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  // wrangler starts workerd as a child: end the whole tree this test started.
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
  } else child.kill('SIGTERM');
}

async function startWorker(settings: RelaySettings) {
  const dir = mkdtempSync(join(tmpdir(), 'rally-relay-'));
  const config = {
    name: 'rally-room-relay-test',
    main: join(root, 'worker', 'index.ts'),
    compatibility_date: '2026-09-01',
    durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'RelayRoom' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['RelayRoom'] }],
    vars: {
      RELAY_HOST_HOLD_MS: String(settings.hostHoldMs),
      RELAY_HANDSHAKE_MS: String(settings.handshakeMs),
      RELAY_IDLE_MS: String(settings.idleMs),
      RELAY_ADDRESS_LIMIT: String(settings.addressLimit),
    },
  };
  const configPath = join(dir, 'wrangler.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const port = await freePort();
  const inspector = await freePort();
  const child = spawn(process.execPath, [
    join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'dev',
    '--config', configPath, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector),
    '--persist-to', join(dir, 'state'), '--show-interactive-dev-session=false', '--log-level', 'warn',
  ], {
    cwd: dir,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (d) => { output += String(d); });
  child.stderr?.on('data', (d) => { output += String(d); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited (${child.exitCode}):\n${output}`);
    try {
      const response = await fetch(`${base}/`);
      if (response.status === 404) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) { stop(child); throw new Error(`wrangler dev did not start:\n${output}`); }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    base: `ws://127.0.0.1:${port}`,
    close: async () => {
      stop(child);
      await new Promise((resolve) => setTimeout(resolve, 300));
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* workerd may still hold a file */ }
    },
  };
}

relayConformance('cloudflare worker (wrangler dev)', startWorker);
