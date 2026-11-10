// Full chain: real host game page + real phone page. The phone gets synthetic
// devicemotion swings whose peak is timed at the host's expected contact, so
// detection, relay, clock sync, hit window and the hit message are all real.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./shots/', import.meta.url));
const BASE = 'https://127.0.0.1:5280';
const JITTER = Number(process.argv[2] ?? 50); // ms of human-like timing spread
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const errors = [];
const watch = (p, n) => { p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error') errors.push(`${n} console: ${m.text()}`); }); };

const host = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } })).newPage(); watch(host, 'host');
await host.goto(BASE + '/');
await host.getByRole('button', { name: 'Play' }).click();
const code = await host.waitForFunction(() => { const m = document.body.innerText.match(/\b([A-HJ-KM-NP-Z]{4})\b/g); return m && m.find((c) => /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/.test(c) && c !== 'PLAY'); }).then((h) => h.jsonValue());
console.log('room', code);

const phoneCtx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const phone = await phoneCtx.newPage(); watch(phone, 'phone');
const received = [];
await phone.exposeFunction('__recv', (m) => received.push(m));
await phone.addInitScript(() => {
  const Orig = window.WebSocket;
  window.WebSocket = class extends Orig { constructor(...a) { super(...a); this.addEventListener('message', (e) => { try { const m = JSON.parse(e.data); if (m.t === 'hit' || m.t === 'miss' || m.t === 'mode' || m.t === 'game') window.__recv(m); } catch {} }); } };
});
await phone.goto(`${BASE}/play/?r=${code}`);
await phone.fill('#name', 'Gustav');
await phone.click('#join-button');
await phone.click('#allow');
// Synthetic sensor: rest samples always, and a bell-shaped swing peaking at a given phone time.
await phone.evaluate(() => {
  const fire = (rot) => dispatchEvent(new DeviceMotionEvent('devicemotion', {
    accelerationIncludingGravity: { x: 9.81, y: 0, z: 0 }, acceleration: { x: 0, y: 0, z: 0 },
    rotationRate: { alpha: rot, beta: 0, gamma: 0 }, interval: 16 }));
  window.__peaks = [];
  setInterval(() => {
    const now = performance.now();
    let w = 0;
    for (const p of window.__peaks) w = Math.max(w, Math.exp(-(((now - p.t) / 45) ** 2)) * p.peak);
    window.__peaks = window.__peaks.filter((p) => now - p.t < 400);
    fire(w);
  }, 16);
  window.__swingAtEpoch = (epoch, peak) => window.__peaks.push({ t: epoch - performance.timeOrigin, peak });
});
await host.waitForTimeout(1500);
await host.screenshot({ path: OUT + 'chain-lobby.png' });
await host.getByRole('radio', { name: 'Rookie' }).check({ force: true });
await host.getByRole('radio', { name: '1 game' }).check({ force: true });
await host.getByRole('button', { name: 'Start match' }).click();
const playerName = await host.evaluate(() => window.__rally.match?.view().players[0].name);
console.log('player 1 in match:', playerName);

// Driver: read the host's expected contact, convert to epoch, schedule a phone swing.
const done = new Set();
let swings = 0, shot = false;
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  const s = await host.evaluate(() => {
    const r = window.__rally, m = r.match; if (!m) return null;
    const v = m.view();
    const toEpoch = (mt) => mt - r.matchNow() + performance.now() + performance.timeOrigin;
    const serving = v.phase === 'serve-wait' && v.players[v.serverIndex].human && !v.message;
    const tc = m.expectedContact(0);
    return { phase: v.phase, rally: v.rally, serving, key: JSON.stringify(v.score) + v.serveNumber, tcEpoch: tc == null ? null : toEpoch(tc), nowEpoch: performance.now() + performance.timeOrigin, score: v.score };
  });
  if (!s || s.phase === 'match-over') break;
  if (s.serving && !done.has('toss' + s.key)) { done.add('toss' + s.key); await phone.evaluate((e) => window.__swingAtEpoch(e, 900), s.nowEpoch + 150); swings++; }
  if (s.tcEpoch && s.tcEpoch - s.nowEpoch < 350 && s.tcEpoch - s.nowEpoch > 130) {
    const k = Math.round(s.tcEpoch / 20);
    if (!done.has(k)) { done.add(k); await phone.evaluate(([e, p]) => window.__swingAtEpoch(e, p), [s.tcEpoch + (Math.random() * 2 - 1) * JITTER, 1100]); swings++; }
  }
  if (!shot && s.rally >= 3) { shot = true; await host.screenshot({ path: OUT + 'chain-rally.png' }); await phone.screenshot({ path: OUT + 'chain-phone.png' }); }
  await host.waitForTimeout(25);
}
await host.waitForTimeout(2500);
const end = await host.evaluate(() => { const v = window.__rally.match.view(); return { phase: v.phase, winner: v.winner, games: v.score.games, longest: v.stats.longestRally, fastest: v.stats.fastestShotKmh }; });
const hits = received.filter((m) => m.t === 'hit'), misses = received.filter((m) => m.t === 'miss');
console.log('seconds', ((Date.now() - t0) / 1000).toFixed(0), 'phone swings scheduled', swings);
console.log('host:', JSON.stringify(end));
console.log('phone got', hits.length, 'hit messages, mean quality', (hits.reduce((a, h) => a + h.quality, 0) / Math.max(hits.length, 1)).toFixed(2), '|', misses.length, 'miss messages');
{ const r = (k) => hits.length ? `${Math.min(...hits.map((h) => h[k])).toFixed(2)}..${Math.max(...hits.map((h) => h[k])).toFixed(2)}` : 'none';
  console.log('contact on phone: frame hits', hits.filter((h) => h.frame === true).length, '| has frame field', hits.every((h) => typeof h.frame === 'boolean'), '| a (u) range', r('u'), '| b (v) range', r('v')); }
console.log('phone modes:', received.filter((m) => m.t === 'mode').map((m) => m.mode).join(' > '));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
