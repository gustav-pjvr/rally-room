// The racket face (the signature move, DESIGN.md section 1): a racket head drawn to fill the
// phone, strings in the team colour, and a ripple that starts where the ball met the strings.
import { clamp01, clampUnit, mix, nearFrame, parseHex, readableOn, rippleStyle, toHex } from './logic';

const INK = '#1B1B1E';
const CREAM = '#F3E9D2';
const BALL = '#D8EF3A';
const BED = '#1B1B1E';
const MAINS = 16;
const CROSSES = 19;
const FLASH_MS = 420;

interface Ripple { x: number; y: number; t0: number; q: number; mishit: boolean }
type Ctx = CanvasRenderingContext2D;

export interface FaceOptions {
  /** Head width over height. A real racket is about 0.76; the play screen stretches it to fill the phone. */
  aspect?: number;
}

export class RacketFace {
  private readonly ctx: Ctx;
  private readonly stencil = document.createElement('canvas');
  private readonly sctx: Ctx;
  private readonly aspect: number;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private frame = '#0F4C5C';
  private strings = '#3A8FA3';
  private label = '';
  private ripples: Ripple[] = [];
  private frameFlash: { t0: number; colour: string } | undefined;
  private raf = 0;
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private g = { cx: 0, cy: 0, rx: 0, ry: 0, fw: 0, bx: 0, by: 0 };

  constructor(private readonly canvas: HTMLCanvasElement, options: FaceOptions = {}) {
    this.ctx = canvas.getContext('2d')!;
    this.sctx = this.stencil.getContext('2d')!;
    this.aspect = options.aspect ?? 0.76;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.reduced.addEventListener?.('change', () => this.draw());
  }

  setColour(team: string) {
    this.frame = team;
    this.strings = readableOn(team, BED, 3.2);
    this.draw();
  }

  /** Painted on the strings like a maker's stencil: the player number. */
  setLabel(label: string) {
    this.label = label;
    this.draw();
  }

  /** `u` across the strings (-1 left .. +1 right), `v` up the strings (-1 bottom .. +1 top). */
  hit(u: number, v: number, quality: number) {
    const { cx, cy, bx, by } = this.g;
    const uu = clampUnit(u), vv = clampUnit(v);
    const q = clamp01(quality);
    const mishit = nearFrame(uu, vv) || q < 0.3;
    // Scale so |(u, v)| = 1 lands just inside the frame.
    this.ripples.push({ x: cx + uu * bx * 0.92, y: cy - vv * by * 0.92, t0: performance.now(), q, mishit });
    if (this.ripples.length > 4) this.ripples.shift();
    // A mishit rings the frame: it flashes pale.
    if (mishit) this.frameFlash = { t0: performance.now(), colour: CREAM };
    this.start();
  }

  miss() {
    this.frameFlash = { t0: performance.now(), colour: INK };
    this.start();
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.w = rect.width;
    this.h = rect.height;
    for (const c of [this.canvas, this.stencil]) {
      c.width = Math.round(this.w * this.dpr);
      c.height = Math.round(this.h * this.dpr);
    }
    const m = Math.max(8, Math.min(this.w, this.h) * 0.035);
    const ry = Math.max(10, Math.min((this.w / 2 - m) / this.aspect, (this.h * 0.84 - m) / 2));
    const rx = Math.min(ry * this.aspect, this.w / 2 - m);
    const fw = Math.max(9, rx * 0.085);
    this.g = { cx: this.w / 2, cy: m + ry, rx, ry, fw, bx: rx - fw / 2 - 1, by: ry - fw / 2 - 1 };
    this.draw();
  }

  private start() {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private tick = () => {
    this.raf = 0;
    this.draw();
    if (this.ripples.length || this.frameFlash) this.raf = requestAnimationFrame(this.tick);
  };

  private draw() {
    const { ctx, w, h, dpr } = this;
    if (!w || !h) return;
    const now = performance.now();
    const reduced = this.reduced.matches;
    this.ripples = this.ripples.filter((r) => now - r.t0 < (reduced ? 600 : rippleStyle(r.q).duration));
    if (this.frameFlash && now - this.frameFlash.t0 > FLASH_MS) this.frameFlash = undefined;
    const live = reduced ? [] : this.ripples;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { cx, cy, rx, ry, fw, bx, by } = this.g;

    this.drawThroat();

    // String bed.
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, bx, by, 0, 0, Math.PI * 2);
    ctx.fillStyle = BED;
    ctx.fill();
    ctx.clip();
    // Reduced motion: the fade lights the bed under still strings. Otherwise rings run over them.
    if (reduced) this.drawRipples(now, true);
    this.drawStrings(ctx, this.strings, now, live);
    if (this.label) this.drawStencil(now, live);
    if (!reduced) this.drawRipples(now, false);
    ctx.restore();

    // Frame: ink outline, team colour, and a flash toward cream (mishit) or ink (miss).
    let colour = this.frame;
    if (this.frameFlash) {
      const k = Math.max(0, 1 - (now - this.frameFlash.t0) / FLASH_MS);
      colour = mixHex(this.frame, this.frameFlash.colour, k * 0.85);
    }
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.lineWidth = fw + 6;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.lineWidth = fw;
    ctx.strokeStyle = colour;
    ctx.stroke();
    // Grommet holes along the frame.
    ctx.fillStyle = INK;
    ctx.globalAlpha = 0.45;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, Math.max(1.2, fw * 0.12), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawThroat() {
    const { ctx, h } = this;
    const { cx, cy, rx, ry, fw } = this.g;
    const bottom = cy + ry;
    if (bottom >= h - 4) return;
    const a = 0.5;
    const sx = rx * Math.sin(a), sy = cy + ry * Math.cos(a);
    const handleTop = bottom + (h - bottom) * 0.45;
    const hw = Math.max(12, fw * 1.25);
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + side * sx, sy);
      ctx.lineTo(cx + side * hw * 0.7, handleTop);
      ctx.lineWidth = fw + 6;
      ctx.strokeStyle = INK;
      ctx.stroke();
      ctx.lineWidth = fw;
      ctx.strokeStyle = this.frame;
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    // Handle with an overgrip wrap.
    ctx.fillStyle = INK;
    ctx.fillRect(cx - hw, handleTop, hw * 2, h - handleTop + 2);
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - hw, handleTop, hw * 2, h - handleTop + 2);
    ctx.clip();
    ctx.strokeStyle = CREAM;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 2;
    for (let y = handleTop - hw * 2; y < h + hw * 2; y += 11) {
      ctx.beginPath();
      ctx.moveTo(cx - hw, y);
      ctx.lineTo(cx + hw, y - hw * 0.8);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawStrings(target: Ctx, colour: string, now: number, live: Ripple[]) {
    const { cx, cy, bx, by } = this.g;
    target.strokeStyle = colour;
    target.lineWidth = Math.max(1.4, bx / 70);
    const steps = 44;
    // Mains run up the head, crosses run across.
    for (let i = 1; i <= MAINS; i++) {
      const x = cx - bx + (2 * bx * i) / (MAINS + 1);
      target.beginPath();
      for (let s = 0; s <= steps; s++) {
        const y = cy - by + (2 * by * s) / steps;
        const d = live.length ? this.displace(x, y, now, live)[0] : 0;
        if (s === 0) target.moveTo(x + d, y); else target.lineTo(x + d, y);
      }
      target.stroke();
    }
    for (let j = 1; j <= CROSSES; j++) {
      const y = cy - by + (2 * by * j) / (CROSSES + 1);
      target.beginPath();
      for (let s = 0; s <= steps; s++) {
        const x = cx - bx + (2 * bx * s) / steps;
        const d = live.length ? this.displace(x, y, now, live)[1] : 0;
        if (s === 0) target.moveTo(x, y + d); else target.lineTo(x, y + d);
      }
      target.stroke();
    }
  }

  /** The number is painted onto the strings only, as on a real racket. */
  private drawStencil(now: number, live: Ripple[]) {
    const { sctx, dpr, w, h } = this;
    const { cx, cy, by } = this.g;
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.clearRect(0, 0, w, h);
    this.drawStrings(sctx, CREAM, now, live);
    sctx.globalCompositeOperation = 'destination-in';
    sctx.fillStyle = INK;
    sctx.font = `900 ${Math.round(by * 0.95)}px "Arial Black", system-ui, sans-serif`;
    sctx.textAlign = 'center';
    sctx.textBaseline = 'middle';
    sctx.fillText(this.label, cx, cy + by * 0.04);
    sctx.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 0.72;
    this.ctx.drawImage(this.stencil, 0, 0, w, h);
    this.ctx.globalAlpha = 1;
  }

  /** Radial wave packet from each ripple: the strings visibly shiver as the ring passes. */
  private displace(x: number, y: number, now: number, ripples: Ripple[]): [number, number] {
    let dx = 0, dy = 0;
    for (const r of ripples) {
      const style = rippleStyle(r.q);
      const p = (now - r.t0) / style.duration;
      if (p >= 1) continue;
      const ex = x - r.x, ey = y - r.y;
      const dist = Math.hypot(ex, ey) || 1;
      const front = style.reach * this.g.by * 1.6 * Math.pow(p, 0.75);
      const lambda = 16 + 10 * r.q;
      const off = (dist - front) / lambda;
      if (Math.abs(off) > 3) continue;
      const amp = style.amplitude * (1 - p) * (1 - p) * Math.exp(-off * off) * Math.sin(off * Math.PI * 1.4);
      dx += (amp * ex) / dist;
      dy += (amp * ey) / dist;
    }
    return [dx, dy];
  }

  private drawRipples(now: number, reduced: boolean) {
    const { ctx } = this;
    for (const r of this.ripples) {
      const style = rippleStyle(r.q);
      // Clean hits ring in ball yellow; mishits and weak hits in pale cream.
      const tint = style.clean && !r.mishit ? BALL : CREAM;
      if (reduced) {
        const k = Math.max(0, 1 - (now - r.t0) / 600);
        ctx.globalAlpha = k * (0.7 + 0.3 * r.q);
        ctx.fillStyle = tint;
        ctx.beginPath();
        ctx.arc(r.x, r.y, 18 + 46 * r.q, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      const p = (now - r.t0) / style.duration;
      const front = style.reach * this.g.by * 1.6 * Math.pow(p, 0.75);
      // Rings stay opaque and thin out as they travel, so the colour stays crisp on the dark bed.
      const thin = Math.pow(1 - p, 1.2);
      ctx.strokeStyle = tint;
      ctx.globalAlpha = Math.min(1, style.alpha + 0.1);
      for (const [lag, weight] of [[0, 1], [0.38, 0.45]] as const) {
        const radius = front * (1 - lag);
        const width = style.ring * thin * weight;
        if (radius < 2 || width < 0.6) continue;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Ball mark: a felt-yellow dot where it struck, shrinking away in the first half.
      if (p < 0.5) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = BALL;
        ctx.strokeStyle = INK;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(r.x, r.y, (6 + 10 * r.q) * (1 - p * 2), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
}

function mixHex(a: string, b: string, t: number): string {
  const pa = parseHex(a), pb = parseHex(b);
  return pa && pb ? toHex(mix(pa, pb, t)) : a;
}
