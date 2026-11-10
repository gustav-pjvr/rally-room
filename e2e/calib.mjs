// Spin calibration flow on the phone page: Node is the host over ws; Chrome plays the phone with synthetic swings.
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire('C:/Users/HP 865 G10/Desktop/Tennis Game/package.json');
const WebSocket = require('ws');
const BASE = 'https://127.0.0.1:5280';
const OUT = fileURLToPath(new URL('./shots/', import.meta.url));
const sizes = (process.argv[2] ?? '390x844,360x740').split(',').map((s) => s.split('x').map(Number));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (ok, what) => { console.log(ok ? 'PASS' : 'FAIL', what); if (!ok) fails.push(what); };

function host() {
  const ws = new WebSocket(`wss://127.0.0.1:5280/ws`, { rejectUnauthorized: false });
  const log = [];
  ws.on('message', (d) => log.push(JSON.parse(String(d))));
  const wait = async (test, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const f = log.find(test); if (f) return f; await sleep(30); } throw new Error('timeout'); };
  return new Promise((resolve) => ws.on('open', () => { ws.send(JSON.stringify({ t: 'host' })); resolve({ ws, log, wait, send: (m) => ws.send(JSON.stringify(m)) }); }));
}

// Each kind: a rest tilt (sets the screen normal's upward part) and a rotation axis (sets the head path).
const KIND = {
  'fh-slice': { tilt: 0.35, w: [1, 0, 0.55] },
  'fh-flat': { tilt: 0, w: [1, 0, 0] },
  'fh-top': { tilt: -0.35, w: [1, 0, -0.55] },
  'bh-slice': { tilt: -0.35, w: [-1, 0, 0.55] },
  'bh-flat': { tilt: 0, w: [-1, 0, 0] },
  'bh-top': { tilt: 0.35, w: [-1, 0, -0.55] },
};

async function swing(page, kind, jitter = 0) {
  const k = KIND[kind];
  await page.evaluate(async ({ tilt, w, jitter }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const a = { x: 9.81 * Math.cos(tilt), y: 0, z: 9.81 * Math.sin(tilt) };
    const fire = (rot) => window.dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: a, rotationRate: { alpha: rot[0], beta: rot[1], gamma: rot[2] }, interval: 16 }));
    for (let i = 0; i < 30; i++) { fire([0, 0, 0]); await sleep(16); }
    const ww = [w[0], w[1], w[2] + jitter];
    const n = Math.hypot(...ww);
    for (let t = 0; t <= 300; t += 16) { const m = Math.exp(-(((t - 120) / 45) ** 2)) * 1200; fire(ww.map((x) => (x / n) * m)); await sleep(16); }
    for (let i = 0; i < 30; i++) { fire([0, 0, 0]); await sleep(16); }
  }, { ...k, jitter });
  await sleep(80);
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const errors = [];
for (const [w, h] of sizes) {
  const tag = String(w);
  const H = await host();
  const { code } = await H.wait((m) => m.t === 'room');
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag} console: ${m.text()}`); });
  const shot = (name) => page.screenshot({ path: `${OUT}calib-${tag}-${name}.png` });

  const join = async (name) => {
    await page.goto(`${BASE}/play/?r=${code}`);
    await page.fill('#name', name);
    await page.click('#join-button');
    await page.waitForSelector('#screen-allow:not([hidden])');
    const joined = await H.wait((m) => m.t === 'player' && m.state === 'in' && !m.__seen);
    joined.__seen = true;
    await page.click('#allow');
    await swing(page, 'fh-flat').catch(() => {});
    await page.waitForSelector('#screen-lobby:not([hidden])');
    H.send({ t: 'mode', to: joined.slot, mode: 'lobby' });
    H.send({ t: 'you', to: joined.slot, player: 1, color: '#B4471A', team: 'Clay Court' });
    await sleep(250);
    return joined.slot;
  };

  await page.goto(`${BASE}/play/?r=${code}`);
  await page.evaluate(() => localStorage.clear());
  let slot = await join('Gustav');
  check(await page.isVisible('#teach'), `${tag} teach card visible in lobby`);
  check((await page.textContent('#teach-state')) === 'automatic', `${tag} starts automatic`);
  await shot('1-card');

  await page.click('#teach-start');
  check(await page.isVisible('#teach-step'), `${tag} step view shows`);
  check((await page.textContent('#teach-title')) === 'Forehand slice', `${tag} first step is forehand slice`);
  check(await page.isDisabled('#teach-redo'), `${tag} redo disabled before any swing`);
  // A follow-through the other way is ignored.
  await swing(page, 'bh-flat');
  check((await page.textContent('#teach-progress')) === 'Swing 3 times', `${tag} wrong-direction swing ignored`);
  await swing(page, 'fh-slice', 0.03);
  await swing(page, 'fh-slice', -0.03);
  check((await page.textContent('#teach-progress')) === '2 of 3 swings', `${tag} counts 2 of 3`);
  check((await page.textContent('#power-value')) !== '0%', `${tag} power meter still shows power`);
  await shot('2-step');
  await page.click('#teach-redo');
  check((await page.textContent('#teach-progress')) === 'Swing 3 times', `${tag} redo clears the step`);

  const steps = ['fh-slice', 'fh-flat', 'fh-top', 'bh-slice', 'bh-flat', 'bh-top'];
  for (const kind of steps) {
    for (const j of [-0.04, 0, 0.04]) await swing(page, kind, j);
  }
  await page.waitForSelector('#teach-done:not([hidden])');
  const result = await page.textContent('#teach-result');
  check(result === 'Spin calibrated for Gustav', `${tag} result text: ${result}`);
  await shot('3-result');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('rally-room-calibration-v1') || 'null'));
  check(!!saved?.gustav?.fh && !!saved?.gustav?.bh, `${tag} saved for gustav`);
  const prof = H.log.filter((m) => m.t === 'profile').at(-1);
  check(prof?.spinCalibrated === true, `${tag} profile report says calibrated`);
  await page.click('#teach-ok');
  check((await page.textContent('#teach-state')) === 'calibrated' && (await page.textContent('#teach-start')) === 'Recalibrate', `${tag} lobby line: calibrated, Recalibrate`);
  await shot('4-calibrated');

  // The calibration is in use: each kind now reads as its own word.
  const words = {};
  for (const kind of ['fh-slice', 'fh-flat', 'fh-top', 'bh-top']) {
    const before = H.log.length;
    await swing(page, kind, 0.02);
    words[kind] = await page.textContent('#spin-word');
    const sw = H.log.slice(before).find((m) => m.t === 'swing');
    check(sw && !('path' in sw) && !('face' in sw), `${tag} wire swing has no path/face`);
  }
  console.log(tag, 'words after calibration', JSON.stringify(words));
  check(words['fh-slice'] === 'Slice' && words['fh-flat'] === 'Flat' && words['fh-top'] === 'Topspin' && words['bh-top'] === 'Topspin', `${tag} calibrated words match the taught kinds`);

  // Reload with the same name: calibrated. Another name: automatic.
  H.ws.close();
  await sleep(300);
  const H2 = await host(); Object.assign(H, H2);
  const room2 = await H.wait((m) => m.t === 'room');
  const code2 = room2.code;
  const rejoin = async (name) => {
    await page.goto(`${BASE}/play/?r=${code2}`);
    await page.fill('#name', name);
    await page.click('#join-button');
    await page.waitForSelector('#screen-allow:not([hidden])');
    await page.click('#allow');
    await swing(page, 'fh-flat').catch(() => {});
    await page.waitForSelector('#screen-lobby:not([hidden])');
    await sleep(200);
  };
  await rejoin('  gustav ');
  check((await page.textContent('#teach-state')) === 'calibrated', `${tag} survives reload for the same name`);
  await rejoin('Anna');
  check((await page.textContent('#teach-state')) === 'automatic', `${tag} another name starts automatic`);
  // Not during play.
  const slotA = H.log.filter((m) => m.t === 'player' && m.state === 'in').at(-1).slot;
  H.send({ t: 'mode', to: slotA, mode: 'lobby' });
  await sleep(150);
  await page.click('#teach-start');
  H.send({ t: 'mode', to: slotA, mode: 'play' });
  await page.waitForSelector('#screen-play:not([hidden])');
  H.send({ t: 'mode', to: slotA, mode: 'lobby' });
  await page.waitForSelector('#screen-lobby:not([hidden])');
  check(await page.isVisible('#teach-idle'), `${tag} a match ends teaching; lobby shows the idle card`);
  H.send({ t: 'mode', to: slotA, mode: 'lab' });
  await sleep(200);
  check(!(await page.isVisible('#teach')), `${tag} no teach card in lab mode`);
  const scroll = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  check(scroll[0] <= scroll[1], `${tag} no horizontal scroll`);
  H.ws.close();
  await ctx.close();
}

// Left-handed player: the Forehand steps expect the physical -1 turn, so the walk-through uses the mirrored kinds.
{
  const tag = 'left';
  const H = await host();
  const { code } = await H.wait((m) => m.t === 'room');
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(tag + ' pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(tag + ' console: ' + m.text()); });
  await page.goto(BASE + '/play/?r=' + code);
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE + '/play/?r=' + code);
  await page.fill('#name', 'Lefty');
  await page.check('input[name=hand][value=Left]', { force: true });
  await page.click('#join-button');
  await page.waitForSelector('#screen-allow:not([hidden])');
  const joined = await H.wait((m) => m.t === 'player' && m.state === 'in');
  await page.click('#allow');
  await swing(page, 'fh-flat').catch(() => {});
  await page.waitForSelector('#screen-lobby:not([hidden])');
  H.send({ t: 'mode', to: joined.slot, mode: 'lobby' });
  await sleep(250);
  check(await page.isVisible('#teach'), tag + ' teach card visible with a gyro');
  await page.click('#teach-start');
  check((await page.textContent('#teach-title')) === 'Forehand slice', tag + ' first step is Forehand slice');
  // A right-hander's forehand turn (+1) is the wrong way round for a left-hander.
  await swing(page, 'fh-slice', 0.03);
  check((await page.textContent('#teach-progress')) === 'Swing 3 times', tag + ' the +1 turn does not count for a left-hander Forehand');
  // Physical kinds: Forehand steps use the -1 swings, Backhand steps the +1 swings.
  const phys = { 'fh-slice': 'bh-slice', 'fh-flat': 'bh-flat', 'fh-top': 'bh-top', 'bh-slice': 'fh-slice', 'bh-flat': 'fh-flat', 'bh-top': 'fh-top' };
  for (const j of [-0.04, 0, 0.04]) await swing(page, phys['fh-slice'], j);
  check((await page.textContent('#teach-title')) === 'Forehand flat', tag + ' step 1 passes with -1 swings');
  // Go back is allowed one step only.
  await page.click('#teach-redo');
  check((await page.textContent('#teach-title')) === 'Forehand slice', tag + ' redo goes back one step');
  check((await page.textContent('#teach-redo')) === 'Redo this step' && (await page.isDisabled('#teach-redo')), tag + ' redo then reads "Redo this step" and is disabled');
  for (const kind of ['fh-slice', 'fh-flat', 'fh-top', 'bh-slice', 'bh-flat', 'bh-top']) {
    for (const j of [-0.04, 0, 0.04]) await swing(page, phys[kind], j);
  }
  await page.waitForSelector('#teach-done:not([hidden])');
  const result = await page.textContent('#teach-result');
  check(result === 'Spin calibrated for Lefty', tag + ' result text: ' + result);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('rally-room-calibration-v1') || 'null'));
  check(!!saved?.lefty?.fh && !!saved?.lefty?.bh, tag + ' saved both physical sides');
  await page.click('#teach-ok');
  const words = {};
  for (const kind of ['fh-slice', 'fh-flat', 'fh-top', 'bh-slice', 'bh-flat', 'bh-top']) {
    await swing(page, kind, 0.02);
    words[kind] = await page.textContent('#spin-word');
  }
  console.log(tag, 'words', JSON.stringify(words));
  check(Object.entries(words).every(([k, w]) => w === { slice: 'Slice', flat: 'Flat', top: 'Topspin' }[k.split('-')[1]]), tag + ' calibration reads every physical kind with its own word');
  // Rejoin the same name on the same page with storage blocked of the saved copy: the in-memory calibration stays.
  await page.evaluate(() => localStorage.removeItem('rally-room-calibration-v1'));
  H.ws.close();
  await page.waitForSelector('#screen-gone:not([hidden])');
  await page.click('#gone-join');
  const H2 = await host();
  const room2 = await H2.wait((m) => m.t === 'room');
  await page.fill('#room', room2.code);
  await page.fill('#name', '  lefty ');
  await page.click('#join-button');
  const joined2 = await H2.wait((m) => m.t === 'player' && m.state === 'in');
  await page.waitForSelector('#screen-lobby:not([hidden])');
  H2.send({ t: 'mode', to: joined2.slot, mode: 'lobby' });
  await sleep(250);
  check((await page.textContent('#teach-state')) === 'calibrated', tag + ' same name rejoin keeps the in-memory calibration');
  await swing(page, 'bh-top', 0.02);
  check((await page.textContent('#spin-word')) === 'Topspin', tag + ' and it still reads Topspin');
  H2.ws.close();
  await ctx.close();
}

// A phone without a gyroscope never gets the teach card.
{
  const tag = 'nogyro';
  const H = await host();
  const { code } = await H.wait((m) => m.t === 'room');
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(tag + ' pageerror: ' + e.message));
  await page.goto(BASE + '/play/?r=' + code);
  await page.fill('#name', 'Plain');
  await page.click('#join-button');
  await page.waitForSelector('#screen-allow:not([hidden])');
  const joined = await H.wait((m) => m.t === 'player' && m.state === 'in');
  await page.click('#allow');
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 90; i++) {
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x: 9.81, y: 0, z: 0 }, interval: 16 }));
      await sleep(8);
    }
  });
  await page.waitForSelector('#screen-lobby:not([hidden])');
  H.send({ t: 'mode', to: joined.slot, mode: 'lobby' });
  await sleep(250);
  check(!(await page.isVisible('#teach')), tag + ' no teach card without a gyro');
  check((await page.evaluate(() => document.body.dataset.teach)) === 'off', tag + ' teach state is off');
  H.ws.close();
  await ctx.close();
}
console.log('errors:', errors.length ? errors : 'none');
console.log('fails:', fails.length ? fails : 'none');
await browser.close();
