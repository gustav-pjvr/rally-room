// Identity by phone id, liveness and keyboard takeover, with fake phones over the relay.
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
const BASE = 'https://127.0.0.1:5280';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); log(ok ? 'PASS' : 'FAIL', name, detail); };
const errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });

async function hostPage() {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/?screen=setup`);
  await page.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('[data-lobby="code"]')?.textContent ?? ''));
  const code = await page.textContent('[data-lobby="code"]');
  return { page, code };
}
function fakePhone(code, name, pid, { pong = true } = {}) {
  const ws = new WebSocket('wss://127.0.0.1:5280/ws', { rejectUnauthorized: false });
  const got = [];
  const state = { pong };
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); got.push(m); if (m.t === 'ping' && state.pong) ws.send(JSON.stringify({ t: 'pong', h: m.h, p: m.h + 5000 })); });
  const open = new Promise((r) => ws.on('open', r));
  return { ws, got, state, send: (m) => ws.send(JSON.stringify(m)),
    async join() { await open; ws.send(JSON.stringify({ t: 'join', room: code, name, pid })); for (let i = 0; i < 100 && !got.some((m) => m.t === 'joined' || m.t === 'error'); i++) await sleep(30); return got.find((m) => m.t === 'joined' || m.t === 'error'); } };
}
const snap = (page) => page.evaluate(() => {
  const r = window.__rally;
  const kb = document.querySelector('[data-act="keyboard"]');
  return { screen: document.querySelector('#overlay').dataset.screen, paused: r.paused, playing: r.playing?.slots,
    seats: r.seats?.map((s) => `${s.name}@${s.slot}${s.ready ? '' : ':notready'}${s.keyboard ? ':kb' : ''}`),
    phones: r.phones.map((p) => `${p.slot}:${p.name}:${p.connected ? 'on' : 'off'}`), heading: document.querySelector('#rr-pause-h')?.textContent,
    keyboardOffered: kb ? !kb.hidden : null,
    p0: r.match?.view().players[0] && { name: r.match.view().players[0].name, lastSwingAt: r.match.view().players[0].lastSwingAt } };
});
const start = (page) => page.getByRole('button', { name: 'Start match' }).click();
const ok = { t: 'status', motion: 'ok', wake: true };

// A: player drops; after 61 s a NEW phone takes the old slot (watcher); the player rejoins on another slot and keeps its player.
async function scenarioA() {
  const { page, code } = await hostPage();
  const alice = fakePhone(code, 'Alice', 'pid-a');
  log('A alice', JSON.stringify(await alice.join()));
  await sleep(500); await start(page); await sleep(800);
  alice.ws.close(); await sleep(800);
  const dropped = await snap(page);
  check('A drop pauses with waiting text', dropped.paused && dropped.heading === "Waiting for Alice's phone", JSON.stringify(dropped));
  await sleep(61000);
  const offered = await snap(page);
  check('A after 60 s the card offers the keyboard', offered.keyboardOffered === true && offered.heading === "Waiting for Alice's phone", JSON.stringify(offered));
  const bob = fakePhone(code, 'Bob', 'pid-b');
  const bj = await bob.join();
  await sleep(500); bob.send(ok); await sleep(2500);
  const afterBob = await snap(page);
  check('A new phone on the old slot is a watcher, match stays paused', bj.slot === 1 && afterBob.paused && afterBob.seats[0] === 'Alice@null:notready'
    && bob.got.filter((m) => m.t === 'mode').at(-1)?.mode === 'lobby', JSON.stringify({ bj, afterBob, bobMode: bob.got.filter((m) => m.t === 'mode').at(-1) }));
  bob.send({ t: 'swing', tp: 1e12, power: 0.8, omega: 900, spin: 0, dir: 1, dur: 100 }); await sleep(300);
  check('A watcher swing ignored', (await snap(page)).p0.lastSwingAt === null);
  const alice2 = fakePhone(code, 'Alice', 'pid-a');
  const aj = await alice2.join();
  await sleep(2500);
  const back = await snap(page);
  check('A same pid rejoins on slot 2, mapped to its player, still waits for motion', aj.slot === 2 && back.seats[0] === 'Alice@2:notready' && back.paused
    && alice2.got.filter((m) => m.t === 'mode').at(-1)?.mode === 'play', JSON.stringify({ aj, back }));
  alice2.send(ok); await sleep(2300);
  const resumed = await snap(page);
  check('A resumes after motion ok + 1.5 s', resumed.screen === 'match' && !resumed.paused && resumed.seats[0] === 'Alice@2', JSON.stringify(resumed));
}

// B: the player's own slot expires; the same pid gets it back (slot free) and keeps the player.
async function scenarioB() {
  const { page, code } = await hostPage();
  const bob = fakePhone(code, 'Bob', 'pid-b2');
  log('B bob', JSON.stringify(await bob.join()));
  const alice = fakePhone(code, 'Alice', 'pid-a2');
  log('B alice', JSON.stringify(await alice.join()));
  await sleep(300); bob.ws.close(); await sleep(500);
  await start(page); await sleep(800);
  alice.ws.close(); await sleep(61500);
  const alice2 = fakePhone(code, 'Alice', 'pid-a2');
  const aj = await alice2.join();
  await sleep(300); alice2.send(ok); await sleep(2300);
  const s = await snap(page);
  check('B rejoin after 61 s keeps the player and resumes', aj.slot === 2 && s.screen === 'match' && !s.paused && s.seats[0] === 'Alice@2', JSON.stringify({ aj, s }));
}

// C: forged relay messages from a phone are dropped.
async function scenarioC() {
  const { page, code } = await hostPage();
  const eve = fakePhone(code, 'Eve', 'pid-e');
  await eve.join();
  await sleep(500); await start(page); await sleep(800);
  eve.send({ t: 'player', state: 'out', name: 'Eve' }); await sleep(800);
  const s = await snap(page);
  eve.send({ t: 'room', code: 'ZZZZ' }); await sleep(500);
  const room = await page.textContent('[data-lobby="code"]');
  check('C forged player out and room ignored', !s.paused && s.screen === 'match' && room === code, JSON.stringify({ s, room }));
}

// D: a silent phone (socket open, no pongs) pauses within about 6 s; the relay then terminates it.
async function scenarioD() {
  const { page, code } = await hostPage();
  const frozen = fakePhone(code, 'Frozen', 'pid-f');
  await frozen.join();
  await sleep(500); await start(page); await sleep(800);
  frozen.state.pong = false;
  const t0 = Date.now();
  let pausedAfter = null;
  while (Date.now() - t0 < 12000) { const s = await snap(page); if (s.paused) { pausedAfter = Date.now() - t0; break; } await sleep(250); }
  const s = await snap(page);
  check('D silent phone pauses within ~6 to 9 s', pausedAfter !== null && pausedAfter <= 9000 && s.heading === "Waiting for Frozen's phone", `paused after ${pausedAfter} ms ${JSON.stringify(s)}`);
}

// E: keyboard takeover after 60 s, then the phone comes back and takes over again without a pause.
async function scenarioE() {
  const { page, code } = await hostPage();
  const kim = fakePhone(code, 'Kim', 'pid-k');
  await kim.join();
  await sleep(500); await start(page); await sleep(800);
  kim.ws.close(); await sleep(61000);
  await page.getByRole('button', { name: 'Continue with the keyboard' }).click(); await sleep(400);
  const s1 = await snap(page);
  await page.keyboard.press('Space'); await sleep(200);
  const s2 = await snap(page);
  check('E keyboard takeover resumes and Space swings for player 1', s1.screen === 'match' && !s1.paused && s1.seats[0] === 'Kim@null:notready:kb' && s2.p0.lastSwingAt !== null, JSON.stringify({ s1, s2 }));
  const kim2 = fakePhone(code, 'Kim', 'pid-k');
  const kj = await kim2.join(); await sleep(300);
  const s3 = await snap(page);
  kim2.send(ok); await sleep(400);
  const s4 = await snap(page);
  check('E phone back: no pause, takes its player again on motion ok', !s3.paused && !s4.paused && s4.seats[0] === `Kim@${kj.slot}`, JSON.stringify({ kj, s3, s4 }));
}

await Promise.all([scenarioA(), scenarioB(), scenarioC(), scenarioD(), scenarioE()]);
await browser.close();
log('errors:', errors.length ? errors : 'none');
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length || errors.length ? 1 : 0);
