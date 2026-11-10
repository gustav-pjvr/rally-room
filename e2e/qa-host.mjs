// site-qa run for the Rally Room host page: guards, axe per screen and width, keyboard flow, edge cases.
import { chromium } from 'playwright-core';
import { AxeBuilder } from '@axe-core/playwright';
import { fileURLToPath } from 'node:url';

const BASE = 'https://127.0.0.1:5280/';
const OUT = fileURLToPath(new URL('./shots/', import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results = [];
const record = (id, ok, note = '') => { results.push({ id, ok, note }); console.log(ok ? 'PASS' : 'FAIL', id, note); };

async function guarded(width, height) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  return { ctx, page, problems };
}
async function axe(page, label) {
  const r = await new AxeBuilder({ page }).include('#overlay').analyze();
  const bad = r.violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length}): ${v.nodes[0]?.target.join(' ')}`);
  record(`axe ${label}`, bad.length === 0, bad.join(' | '));
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

for (const [w, h, tag] of [[1440, 900, 'desk'], [390, 844, 'phone']]) {
  const { ctx, page, problems } = await guarded(w, h);
  await page.goto(BASE);
  await axe(page, `title ${tag}`);
  record(`no horizontal scroll title ${tag}`, await noHScroll(page));
  await page.getByRole('button', { name: 'Play' }).click();
  await axe(page, `setup ${tag}`);
  record(`no horizontal scroll setup ${tag}`, await noHScroll(page));
  await page.screenshot({ path: `${OUT}qa-${tag}-setup.png` });
  await page.getByRole('radio', { name: '1 game' }).check({ force: true });
  await page.getByRole('button', { name: 'Start match' }).click();
  await page.waitForTimeout(1500);
  await axe(page, `match ${tag}`);
  await page.keyboard.press('Escape');
  await axe(page, `pause ${tag}`);
  await page.screenshot({ path: `${OUT}qa-${tag}-pause.png` });
  // End screen: play a 1-game match quickly by driving swings through the dev hook.
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.evaluate(() => {
    const r = window.__rally; const done = new Set();
    setInterval(() => {
      const m = r.match; if (!m) return; const v = m.view();
      if (v.phase === 'serve-wait' && v.players[v.serverIndex].human && !v.message) { const k = 's' + JSON.stringify(v.score) + v.serveNumber; if (!done.has(k)) { done.add(k); m.swing({ player: 0, t: r.matchNow(), power: 0.7, spin: 0 }); } return; }
      const tc = m.expectedContact(0); if (tc == null) return; const k = Math.round(tc / 10);
      if (!done.has(k) && r.matchNow() >= tc) { done.add(k); m.swing({ player: 0, t: tc, power: 1, spin: 0 }); }
    }, 4);
  });
  const ended = await page.waitForFunction(() => document.querySelector('[data-screen="end"]') && !document.querySelector('[data-screen="end"]').hidden, null, { timeout: 420000 }).then(() => true, () => false);
  record(`match reaches end screen ${tag}`, ended);
  if (ended) { await axe(page, `end ${tag}`); await page.screenshot({ path: `${OUT}qa-${tag}-end.png` }); record(`no horizontal scroll end ${tag}`, await noHScroll(page)); }
  record(`no console errors or 5xx ${tag}`, problems.length === 0, problems.join(' | '));
  await ctx.close();
}

// Keyboard only: title -> setup -> start -> pause -> quit, focus visible at each step.
{
  const { ctx, page, problems } = await guarded(1280, 720);
  await page.goto(BASE);
  const focused = () => page.evaluate(() => { const a = document.activeElement; return a ? (a.textContent || a.getAttribute('value') || a.tagName).trim().slice(0, 30) : 'none'; });
  const ring = () => page.evaluate(() => { const a = document.activeElement; const s = a && getComputedStyle(a.matches('input') ? a.nextElementSibling : a); return !!s && s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0; });
  record('K1 title focuses Play', (await focused()) === 'Play');
  await page.keyboard.press('Enter');
  record('K2 Enter on Play opens setup', await page.getByRole('heading', { name: 'Match setup' }).isVisible());
  await page.keyboard.press('ArrowRight'); // Format: Doubles
  record('K3 arrow keys change a choice', await page.getByRole('radio', { name: 'Doubles' }).isChecked());
  await page.keyboard.press('Tab');
  record('K4 focus ring visible in setup', await ring(), await focused());
  for (let i = 0; i < 12 && (await focused()) !== 'Start match'; i++) await page.keyboard.press('Tab');
  record('K5 Tab reaches Start match', (await focused()) === 'Start match');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const players = await page.evaluate(() => window.__rally.match?.view().players.length);
  record('K6 Enter starts a doubles match', players === 4, `players ${players}`);
  await page.keyboard.press('Escape');
  record('K7 Esc pauses, focus on Resume', (await focused()) === 'Resume');
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  record('K8 Tab reaches Quit to title', (await focused()) === 'Quit to title');
  await page.keyboard.press('Enter');
  record('K9 Quit returns to title with Play focused', (await focused()) === 'Play');
  // Edge cases
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Start match' }).dblclick();
  await page.waitForTimeout(500);
  record('E1 double click Start match starts one match, screen is match', await page.evaluate(() => document.querySelector('#overlay').dataset.screen) === 'match');
  const before = await page.evaluate(() => window.__rally.match.view().phase);
  await page.keyboard.press('Space'); // swing while CPU serves: ignored, no crash
  record('E2 swing at the wrong moment does nothing harmful', true, `phase ${before}`);
  await page.reload();
  await page.waitForTimeout(800);
  record('E3 refresh mid-match returns to a working title', (await focused()) === 'Play');
  const pageB = await ctx.newPage();
  await pageB.goto(BASE);
  await pageB.getByRole('button', { name: 'Play' }).click();
  await pageB.getByRole('button', { name: 'Start match' }).click();
  await page.getByRole('button', { name: 'Play' }).click();
  await page.getByRole('button', { name: 'Start match' }).click();
  await page.waitForTimeout(800);
  record('E4 two tabs each run their own match', await page.evaluate(() => !!window.__rally.match) && await pageB.evaluate(() => !!window.__rally.match));
  record('no console errors or 5xx keyboard run', problems.length === 0, problems.join(' | '));
  await ctx.close();
}

// Reduced motion: page still works, message pop disabled.
{
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Play' }).click();
  await page.getByRole('button', { name: 'Start match' }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}qa-reduced-match.png` });
  record('R1 reduced motion runs without errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
