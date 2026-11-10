// site-qa for Phase 3: phone page states and the host lobby.
import { chromium } from 'playwright-core';
import { AxeBuilder } from '@axe-core/playwright';
import { fileURLToPath } from 'node:url';

const BASE = 'https://127.0.0.1:5280';
const OUT = fileURLToPath(new URL('./shots/', import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results = [];
const record = (id, ok, note = '') => { results.push({ id, ok }); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const problems = [];
const guard = (p, n) => { p.on('pageerror', (e) => problems.push(`${n} pageerror ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error') problems.push(`${n} console ${m.text()}`); }); p.on('response', (r) => { if (r.status() >= 500) problems.push(`${n} HTTP ${r.status()}`); }); };
async function axe(page, label, scope) {
  const b = new AxeBuilder({ page }); if (scope) b.include(scope);
  const r = await b.analyze();
  const bad = r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes[0]?.target.join(' ')}`);
  record(`axe ${label}`, bad.length === 0, bad.join(' | '));
}
const noH = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const visibleScreen = (p) => p.evaluate(() => [...document.querySelectorAll('.screen')].find((s) => !s.hidden)?.id);

const host = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } })).newPage(); guard(host, 'host');
await host.goto(BASE + '/');
await host.getByRole('button', { name: 'Play' }).click();
const code = await host.waitForFunction(() => { const m = document.body.innerText.match(/\b[ABCDEFGHJKMNPQRSTUVWXYZ]{4}\b/g); return m && m.find((c) => c !== 'PLAY'); }).then((h) => h.jsonValue());

for (const [w, h] of [[390, 844], [360, 740]]) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage(); guard(p, `phone${w}`);
  // P1 empty / error: wrong room code shows a readable error with a next step.
  await p.goto(`${BASE}/play/`);
  await axe(p, `phone join ${w}`);
  record(`P1 no horizontal scroll join ${w}`, await noH(p));
  await p.fill('#room', 'ZZZZ'); await p.fill('#name', 'Ann');
  await p.click('#join-button');
  await p.waitForSelector('#join-error:not([hidden])', { timeout: 5000 }).catch(() => {});
  const err = await p.locator('#join-error').innerText().catch(() => '');
  record(`P2 unknown room shows an error ${w}`, err.length > 5, err);
  // P3 long name (30 max) and emoji, double tap Join joins once.
  await p.fill('#room', code);
  await p.fill('#name', 'Ånne-Marié 🎾 Van Der Westhuizen');
  const nameVal = await p.inputValue('#name');
  record(`P3 name limited to 30 chars ${w}`, [...nameVal].length <= 30, nameVal);
  await p.locator('#join-button').dblclick();
  await p.waitForSelector('#screen-allow:not([hidden])');
  await axe(p, `phone allow ${w}`);
  await p.click('#allow');
  await p.evaluate(() => setInterval(() => dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x: 9.81, y: 0, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 })), 16));
  await p.waitForSelector('#screen-lobby:not([hidden])', { timeout: 8000 }).catch(() => {});
  record(`P4 lobby reached ${w}`, (await visibleScreen(p)) === 'screen-lobby');
  await axe(p, `phone lobby ${w}`);
  record(`P5 no horizontal scroll lobby ${w}`, await noH(p));
  await p.screenshot({ path: `${OUT}qa3-phone-${w}-lobby.png` });
  await ctx.close();
}
const players = await host.evaluate(() => document.body.innerText.match(/Ånne[^\n]*/)?.[0]);
record('H1 host lobby shows joined phone with long name', !!players, players ?? '');
const dupes = (await host.locator('text=/Ånne/').count());
record('H2 double tap joined once per phone (2 phones, 2 cards)', dupes <= 2, `cards ${dupes}`);
await axe(host, 'host lobby 1280', '#overlay');
await host.screenshot({ path: `${OUT}qa3-host-lobby.png` });
// Keyboard on the phone join form.
{
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage(); guard(p, 'phonekb');
  await p.goto(`${BASE}/play/?r=${code}`);
  await p.focus('#name'); await p.keyboard.type('Kim'); await p.keyboard.press('Enter');
  await p.waitForSelector('#screen-allow:not([hidden])', { timeout: 5000 }).catch(() => {});
  record('K1 Enter in the name field joins', (await visibleScreen(p)) === 'screen-allow');
  const ring = await p.evaluate(() => { document.querySelector('#allow').focus(); const s = getComputedStyle(document.querySelector('#allow')); return s.outlineStyle !== 'none'; });
  record('K2 focus ring on Allow motion', ring);
  await ctx.close();
}
record('no console errors or 5xx', problems.length === 0, problems.join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
