/**
 * The swing trace: a short record of how the phone turned through one swing,
 * sent after the swing message so the host can draw the racket's path in the
 * point replay (docs/v2/DECISIONS.md D6).
 *
 * This sits beside the swing detector and never touches it: it only keeps a
 * copy of samples the phone page already has (the mapped rotation rate and
 * the detector's gravity estimate).
 */

export type Vec = [number, number, number];

/** Kept before and after the peak, ms. */
export const TRACE_BEFORE_MS = 380;
export const TRACE_AFTER_MS = 220;
/** Most samples a trace may hold (about 0.6 s at 100 Hz). */
export const TRACE_MAX_SAMPLES = 64;
/** A rotation rate above this is not a hand's (deg/s); values are clamped to it on the wire. */
export const TRACE_MAX_RATE = 6000;

/** The wire form: integers only, so it stays small. */
export interface SwingTrace {
  /** Phone time of the swing's peak, ms: the same `tp` as the swing message it belongs to. */
  tp: number;
  /** Time of the first sample relative to the peak (negative), and the mean step between samples, ms. */
  t0: number;
  step: number;
  /** Up (toward the sky) in phone coordinates at the first sample, unit vector times 100. */
  up: Vec;
  /** The racket's long axis in phone coordinates, unit vector times 100. */
  axis: Vec;
  /** Rotation rates about the phone's x, y, z, deg/s, rounded: three numbers per sample. */
  w: number[];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown): v is Vec => Array.isArray(v) && v.length === 3 && v.every(finite);

/** True for a well-formed trace within the size limits. The host checks every trace with this before using it. */
export function isTrace(value: unknown): value is SwingTrace {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  if (!finite(m.tp) || !finite(m.t0) || !finite(m.step) || !isVec(m.up) || !isVec(m.axis) || !Array.isArray(m.w)) return false;
  if (m.step <= 0 || m.step > 100 || m.t0 > 0 || m.t0 < -2000) return false;
  if (m.w.length < 6 || m.w.length > TRACE_MAX_SAMPLES * 3 || m.w.length % 3 !== 0) return false;
  return m.w.every((x) => finite(x) && Math.abs(x) <= TRACE_MAX_RATE);
}

interface Kept { t: number; w: Vec; up: Vec }

/**
 * Phone side. Feed every sensor sample to add(); call mark() when the
 * detector reports a swing; take() returns the finished trace once the
 * stretch after the peak has been recorded (call it after every sample).
 */
export class TraceRecorder {
  private ring: Kept[] = [];
  private pending: { tp: number; axis: Vec } | null = null;

  /** `rotation` is the rate about the phone's x, y, z in deg/s (null without a gyroscope); `up` the gravity estimate's direction. */
  add(t: number, rotation: Vec | null, up: Vec): void {
    if (!rotation || !rotation.every(Number.isFinite) || !up.every(Number.isFinite)) return;
    this.ring.push({ t, w: rotation, up });
    while (this.ring.length && t - this.ring[0].t > TRACE_BEFORE_MS + TRACE_AFTER_MS + 400) this.ring.shift();
  }

  /** A swing with its peak at `tp` was detected; `axis` is the racket's axis as the phone has learned it. */
  mark(tp: number, axis: Vec): void {
    this.pending = { tp, axis };
  }

  take(now: number): SwingTrace | null {
    const p = this.pending;
    if (!p || now < p.tp + TRACE_AFTER_MS) return null;
    this.pending = null;
    let kept = this.ring.filter((s) => s.t >= p.tp - TRACE_BEFORE_MS && s.t <= p.tp + TRACE_AFTER_MS);
    if (kept.length < 4) return null;
    if (kept.length > TRACE_MAX_SAMPLES) kept = kept.slice(kept.length - TRACE_MAX_SAMPLES);
    const unit = (v: Vec): Vec => {
      const n = Math.hypot(v[0], v[1], v[2]) || 1;
      return [Math.round((v[0] / n) * 100), Math.round((v[1] / n) * 100), Math.round((v[2] / n) * 100)];
    };
    const clampRate = (x: number) => Math.round(Math.max(-TRACE_MAX_RATE, Math.min(TRACE_MAX_RATE, x)));
    return {
      tp: p.tp,
      t0: Math.round(kept[0].t - p.tp),
      step: Math.round(((kept[kept.length - 1].t - kept[0].t) / (kept.length - 1)) * 100) / 100,
      up: unit(kept[0].up),
      axis: unit(p.axis),
      w: kept.flatMap((s) => s.w.map(clampRate)),
    };
  }
}

// ---- host side: the racket's path ----

type Quat = [number, number, number, number];
const qmul = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
const rotate = (q: Quat, v: Vec): Vec => {
  const [w, x, y, z] = q;
  const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w - iw * x - iy * z + iz * y, iy * w - iw * y - iz * x + ix * z, iz * w - iw * z - ix * y + iy * x];
};
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v: Vec): Vec => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };

export interface SwingPath {
  /**
   * The racket head's position at each sample, as a direction from the
   * player's shoulder (unit length): x to the player's right, y up, z back
   * (so the swing travels toward -z, the way the player faces).
   */
  points: Vec[];
  /** Time of each point relative to the peak, ms. */
  times: number[];
  /** Index of the point nearest the peak. */
  peak: number;
}

/**
 * Rebuild the racket head's path from a trace: integrate the rotation rates
 * into the phone's orientation, follow the racket's axis through it, then
 * turn the result so that up is up and the head is travelling forward at the
 * peak. The phone cannot know which way the player faced, and the game does
 * (toward the net), so the heading is the one thing taken from the game.
 */
export function swingPath(trace: SwingTrace): SwingPath {
  const n = trace.w.length / 3;
  const axis = norm(trace.axis);
  const up = norm(trace.up);
  let q: Quat = [1, 0, 0, 0];
  const heads: Vec[] = [];
  const times: number[] = [];
  const dt = trace.step / 1000;
  for (let i = 0; i < n; i++) {
    heads.push(rotate(q, axis));
    times.push(trace.t0 + i * trace.step);
    // Body rates: the next orientation is this one turned by w * dt about the phone's own axes.
    const w: Vec = [trace.w[i * 3], trace.w[i * 3 + 1], trace.w[i * 3 + 2]];
    const angle = (Math.hypot(w[0], w[1], w[2]) * Math.PI / 180) * dt;
    if (angle > 1e-9) {
      const a = norm(w);
      const s = Math.sin(angle / 2);
      q = qmul(q, [Math.cos(angle / 2), a[0] * s, a[1] * s, a[2] * s]);
    }
  }
  let peak = 0;
  for (let i = 1; i < n; i++) if (Math.abs(times[i]) < Math.abs(times[peak])) peak = i;
  // Forward: the head's horizontal direction of travel at the peak.
  const a = heads[Math.max(0, peak - 1)], b = heads[Math.min(n - 1, peak + 1)];
  const v: Vec = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const lift = dot(v, up);
  let forward: Vec = [v[0] - lift * up[0], v[1] - lift * up[1], v[2] - lift * up[2]];
  if (Math.hypot(forward[0], forward[1], forward[2]) < 1e-6) {
    // A purely vertical move: any horizontal direction will do.
    forward = cross(up, Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  }
  forward = norm(forward);
  const right = norm(cross(forward, up));
  const points = heads.map((h): Vec => [dot(h, right), dot(h, up), -dot(h, forward)]);
  return { points, times, peak };
}
