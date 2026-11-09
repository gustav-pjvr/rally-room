import '../styles/main.css';
import QRCode from 'qrcode';
import { hostConnection } from '../host/net';
import type { ProfileReport, Sample, Swing } from '../shared/swing';
const status = (s: string) => { document.querySelector('#status')!.textContent = s; };
type Player = { samples: Sample[]; swings: Swing[]; canvas: HTMLCanvasElement; info: HTMLElement };
const players = new Map<number, Player>();
let recording = false;
let rows: string[] = [];
const label = () => document.querySelector<HTMLSelectElement>('#label')!.value;
document.querySelector('#record')!.addEventListener('click', e => {
  recording = !recording;
  if (recording) rows = ['kind,slot,phone_t,host_t,ax,ay,az,gx,gy,gz,rx,ry,rz,power,spin,dir,omega,dur,label'];
  (e.target as HTMLElement).textContent = recording ? 'Stop recording' : 'Record';
});
document.querySelector('#download')!.addEventListener('click', () => {
  if (rows.length < 2) { status('Record some sensor data before downloading.'); return; }
  const url = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = `rally-room-${Date.now()}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
const net = hostConnection(async m => {
  if (m.t === 'room') {
    document.querySelector('#code')!.textContent = String(m.code);
    try {
      const lan = await fetch('/api/lan').then(r => r.json());
      const url = `https://${lan.ips[0] || location.hostname}:${lan.port}/play/?r=${m.code}`;
      document.querySelector<HTMLInputElement>('#url')!.value = url;
      await QRCode.toCanvas(document.querySelector('#qr'), url, { width: 240, margin: 2 });
    } catch { status('Could not create phone link. Reload and check the dev server.'); }
  }
  const slot = Number(m.slot);
  if (m.t === 'player') {
    let p = players.get(slot);
    if (!p) {
      const card = document.createElement('article');
      const title = document.createElement('h2'); const info = document.createElement('p'); const canvas = document.createElement('canvas');
      canvas.width = 900; canvas.height = 240; canvas.setAttribute('aria-label', 'Last five seconds: angular speed, three rotation axes and acceleration');
      card.append(title, info, canvas); document.querySelector('#players')!.append(card);
      p = { samples: [], swings: [], canvas, info }; players.set(slot, p);
    }
    p.canvas.parentElement!.querySelector('h2')!.textContent = `${slot}. ${m.name} / ${m.state === 'in' ? 'connected' : 'disconnected'}`;
  }
  const p = players.get(slot); if (!p) return;
  if (m.t === 'raw' && Array.isArray(m.s)) {
    for (const s of m.s as Sample[]) {
      if (!Array.isArray(s) || s.length !== 10 || !s.every(Number.isFinite)) continue;
      p.samples.push(s);
      if (recording) rows.push(['raw', slot, s[0], s[0] - (net.clocks.get(slot)?.best?.offset || 0), ...s.slice(1), '', '', '', '', '', label()].join(','));
    }
    const latest = p.samples.at(-1)?.[0] || 0; p.samples = p.samples.filter(s => s[0] >= latest - 5000); p.swings = p.swings.filter(s => s.tp >= latest - 5000);
  }
  if (m.t === 'swing') {
    const s = m as unknown as Swing; p.swings.push(s);
    if (recording) rows.push(['swing', slot, s.tp, s.tp - (net.clocks.get(slot)?.best?.offset || 0), ...Array(9).fill(''), s.power, s.spin, s.dir, s.omega, s.dur, label()].join(','));
  }
  if (m.t === 'status') p.info.textContent = `Motion: ${m.motion} / screen awake: ${m.wake}`;
  if (m.t === 'profile') {
    const r = m as unknown as ProfileReport;
    let line = p.info.parentElement!.querySelector<HTMLElement>('.profile');
    if (!line) { line = document.createElement('p'); line.className = 'profile'; p.info.after(line); }
    const mode = r.mode === 'accel' ? 'no gyro, accelerometer only' : r.mode;
    const cap = r.gyroCap ? ` Gyro tops out at ${Math.round(r.gyroCap)} deg/s.` : '';
    line.textContent = `Phone setup: ${mode}. Axes ${r.axes} ${r.axesLearned ? 'learned' : 'default'} (${r.axisMoves} moves). `
      + `Racket axis ${r.racket.map((v) => v.toFixed(2)).join(', ')} from ${r.racketSwings} swings. Spin offset ${r.spinOffset.toFixed(2)}.${cap}`;
  }
}, status);
function draw() {
  for (const [slot, p] of players) {
    const ctx = p.canvas.getContext('2d')!; const end = p.samples.at(-1)?.[0] || 0;
    ctx.clearRect(0, 0, 900, 240); ctx.font = '12px system-ui';
    const colors = ['#0F4C5C', '#963c12', '#5a4488', '#276329', '#1B1B1E'];
    ['omega', 'rot x', 'rot y', 'rot z', '|accel| x 30'].forEach((label, i) => { ctx.fillStyle = colors[i]; ctx.fillText(label, 12 + i * 140, 18); });
    for (let line = 0; line < 5; line++) {
      ctx.strokeStyle = colors[line]; ctx.beginPath();
      p.samples.forEach((s, i) => { const value = line === 0 ? Math.hypot(...s.slice(7)) : line === 4 ? Math.hypot(...s.slice(1, 4)) * 30 : s[6 + line]; const x = 900 * (1 - (end - s[0]) / 5000); const y = 130 - value / 22; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke();
    }
    ctx.fillStyle = '#1B1B1E';
    for (const s of p.swings) { const x = 900 * (1 - (end - s.tp) / 5000); ctx.fillRect(x, 30, 1, 170); ctx.fillText(`P${s.power.toFixed(2)} S${s.spin.toFixed(2)} D${s.dir}`, Math.min(x, 750), 220); }
    const clock = net.clocks.get(slot)?.best;
    ctx.fillText(clock && Number.isFinite(clock.rtt) ? `RTT ${clock.rtt.toFixed(1)} ms / offset ${clock.offset.toFixed(1)} ms` : 'Measuring connection...', 12, 237);
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
