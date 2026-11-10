import { chromium } from 'playwright-core';
import { AxeBuilder } from '@axe-core/playwright';
const BASE = 'https://127.0.0.1:5280';
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const host = await (await b.newContext({ ignoreHTTPSErrors: true })).newPage();
await host.goto(BASE + '/'); await host.getByRole('button', { name: 'Play' }).click();
const code = await host.waitForFunction(() => { const m = document.body.innerText.match(/\b[ABCDEFGHJKMNPQRSTUVWXYZ]{4}\b/g); return m && m.find((c) => c !== 'PLAY'); }).then((h) => h.jsonValue());
let fails = 0; const errs = [];
for (const [w, h] of [[390, 844], [360, 740]]) {
  const p = await (await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: w, height: h }, isMobile: true, hasTouch: true })).newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`${BASE}/play/?r=${code}`); await p.fill('#name', 'Tester'); await p.click('#join-button'); await p.click('#allow');
  await p.evaluate(() => setInterval(() => dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x: 9.81, y: 0, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 })), 16));
  await p.waitForSelector('#teach:not([hidden])', { timeout: 8000 });
  for (const state of ['idle', 'step']) {
    if (state === 'step') { await p.click('#teach-start'); await p.waitForSelector('#teach-step:not([hidden])'); }
    const r = await new AxeBuilder({ page: p }).analyze();
    const bad = r.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`);
    const noH = await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    const ok = !bad.length && noH; if (!ok) fails++;
    console.log(ok ? 'PASS' : 'FAIL', `axe + no sideways scroll, calibration ${state}, ${w}px`, bad.join(' | '));
  }
  await p.click('#teach-skip');
  const idle = await p.isVisible('#teach-idle');
  console.log(idle ? 'PASS' : 'FAIL', `skip returns to the card, ${w}px`); if (!idle) fails++;
}
console.log('page errors:', errs.length ? errs : 'none', '| failed', fails);
await b.close();
