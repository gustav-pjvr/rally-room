// Rejoin and reload behaviour with the real phone page:
// F: re-scan in a new tab keeps the player; G: reload then Join only does not resume until Allow motion;
// H: a phone that becomes a watcher loses its player number.
import { chromium } from 'playwright-core';
const BASE = 'https://127.0.0.1:5280';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); log(ok ? 'PASS' : 'FAIL', name, detail); };
const errors = [];
const watch = (p, n) => { p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error') errors.push(`${n} console: ${m.text()}`); }); };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const host = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } })).newPage(); watch(host, 'host');
await host.goto(`${BASE}/?screen=setup`);
await host.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('[data-lobby="code"]')?.textContent ?? ''));
const code = await host.textContent('[data-lobby="code"]');
log('room', code);
const pctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await pctx.addInitScript(() => {
  addEventListener('load', () => setInterval(() => dispatchEvent(new DeviceMotionEvent('devicemotion', {
    accelerationIncludingGravity: { x: 9.81, y: 0, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 })), 16));
});
const openPhone = async (n) => { const p = await pctx.newPage(); watch(p, n); await p.goto(`${BASE}/play/?r=${code}`); return p; };
const phoneSnap = (p) => p.evaluate(() => ({ screen: document.body.dataset.screen, kicker: document.getElementById('lobby-kicker')?.textContent,
  goneTitle: document.getElementById('gone-title')?.textContent }));
const hs = () => host.evaluate(() => { const r = window.__rally; return { screen: document.querySelector('#overlay').dataset.screen, paused: r.paused,
  playing: r.playing?.slots, seats: r.seats?.map((s) => `${s.name}@${s.slot}${s.ready ? '' : ':notready'}`), heading: document.querySelector('#rr-pause-h')?.textContent }; });

const tab1 = await openPhone('tab1');
await tab1.fill('#name', 'Gustav');
await tab1.click('#join-button');
await tab1.click('#allow');
await sleep(1200);
await host.getByRole('button', { name: 'Start match' }).click();
await sleep(1000);
const started = await hs();
log('started', JSON.stringify(started), JSON.stringify(await phoneSnap(tab1)));

// F: re-scan the QR in a new tab (same browser, so same localStorage): same pid, same player.
const tab2 = await openPhone('tab2');
await tab2.click('#join-button');
await sleep(1500);
const f1 = await hs();
check('F new tab joins as the same player (paused until its motion is ok)', f1.seats?.[0] === 'Gustav@1:notready' && f1.paused, JSON.stringify(f1));
const old = await phoneSnap(tab1);
check('F old tab is told it moved to another tab', old.screen === 'gone' && /another tab/.test(old.goneTitle ?? ''), JSON.stringify(old));
await tab2.click('#allow');
await sleep(2500);
const f2 = await hs();
check('F after Allow motion in the new tab, play resumes', f2.screen === 'match' && !f2.paused && f2.seats?.[0] === 'Gustav@1', JSON.stringify(f2));
await tab1.close();

// G: reload the playing phone, tap Join only: the match must stay paused until Allow motion.
await tab2.reload();
await sleep(1000);
await tab2.click('#join-button');
await sleep(3000);
const g1 = await hs();
check('G reload then Join only stays paused', g1.paused && g1.screen === 'pause' && g1.heading === "Waiting for Gustav's phone", JSON.stringify(g1));
await tab2.click('#allow');
await sleep(2500);
const g2 = await hs();
check('G resumes after Allow motion', g2.screen === 'match' && !g2.paused, JSON.stringify(g2));

// H: quit, switch to singles with another phone first in line: the you message with player null clears the number.
await host.keyboard.press('Escape'); await sleep(300);
await host.getByRole('button', { name: 'Quit to title' }).click(); await sleep(300);
const kicker = (await phoneSnap(tab2)).kicker;
check('H after the match the phone is player 1 in the lobby', /player 1/.test(kicker ?? ''), kicker);
const octx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await octx.addInitScript(() => {
  addEventListener('load', () => setInterval(() => dispatchEvent(new DeviceMotionEvent('devicemotion', {
    accelerationIncludingGravity: { x: 9.81, y: 0, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 })), 16));
});
const other = await octx.newPage(); watch(other, 'other');
await other.goto(`${BASE}/play/?r=${code}`);
await other.fill('#name', 'Ana');
await other.click('#join-button');
await other.click('#allow');
await sleep(1000);
await host.getByRole('button', { name: 'Play' }).click().catch(() => {});
await sleep(300);
await host.getByRole('radio', { name: 'Doubles' }).check({ force: true });
await host.locator('input[name="humans"][value="2"]').check({ force: true });
await sleep(800);
const h1 = await other.evaluate(() => document.getElementById('lobby-kicker')?.textContent);
await host.getByRole('radio', { name: 'Singles' }).check({ force: true });
await sleep(800);
const h2 = await other.evaluate(() => document.getElementById('lobby-kicker')?.textContent);
check('H player null clears the number (player 2 in doubles, watching in singles)', /player 2/.test(h1 ?? '') && h2 === 'You are in', JSON.stringify({ h1, h2 }));
await browser.close();
log('errors:', errors.length ? errors : 'none');
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length || errors.length ? 1 : 0);
