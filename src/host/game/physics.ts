import { COURT, type Vec3 } from './types';

/**
 * Analytic ball flight (DESIGN.md section 5). Constant acceleration
 * a = (0, -(9.81 + 6 * spin), 0), no drag, so the shot solver and the
 * simulation agree exactly. Times here are seconds.
 */

export const GRAVITY = 9.81;
/** Extra downward pull per unit of topspin (negative spin, slice, floats). */
export const SPIN_PULL = 6;
/** The net and its posts span the doubles width plus 0.914 m each side. */
export const NET_HALF_SPAN: number = COURT.doublesHalfWidth + 0.914;
/** Ground contact: the ball's centre is one radius above the court. */
export const GROUND_Y: number = COURT.ballRadius;
/** Horizontal slow-down of a rolling ball, per second. */
const ROLL_DECAY = 2;

export interface Flight { p0: Vec3; v0: Vec3; spin: number }

/** One piece of a ball path; t0 is seconds since the path started. */
export interface Segment extends Flight { t0: number; kind: 'air' | 'roll' }

export interface PathEvent {
  /** Seconds since the path started. */
  t: number;
  kind: 'net' | 'bounce';
  pos: Vec3;
  /** Bounce number (1 for the first bounce); 0 for the net. */
  index: number;
}

export interface BallPath { segments: Segment[]; events: PathEvent[] }

export const clampSpin = (spin: number) => Math.max(-1, Math.min(1, spin));

/** Vertical acceleration for a given spin (always negative for spin in -1..1). */
export const accelY = (spin: number) => -(GRAVITY + SPIN_PULL * clampSpin(spin));

export const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export function positionAt(f: Flight, t: number): Vec3 {
  const a = accelY(f.spin);
  return vec(f.p0.x + f.v0.x * t, f.p0.y + f.v0.y * t + 0.5 * a * t * t, f.p0.z + f.v0.z * t);
}

export function velocityAt(f: Flight, t: number): Vec3 {
  return vec(f.v0.x, f.v0.y + accelY(f.spin) * t, f.v0.z);
}

/** Time until the ball comes down to height y (the later root); Infinity if it never does. */
export function timeToHeight(f: Flight, y = GROUND_Y): number {
  const a = accelY(f.spin);
  const d = f.v0.y * f.v0.y - 2 * a * (f.p0.y - y);
  if (d < 0) return Infinity;
  return (f.v0.y + Math.sqrt(d)) / -a;
}

/** First landing of a flight, ignoring the net. */
export function predictLanding(f: Flight): { t: number; pos: Vec3 } {
  const t = timeToHeight(f);
  const pos = positionAt(f, t);
  return { t, pos: { ...pos, y: GROUND_Y } };
}

/**
 * Where the flight crosses the net plane z = 0, if it does, and whether it
 * clears the 0.95 m wall. Outside the net's span the ball always passes.
 */
export function netCrossing(f: Flight): { t: number; pos: Vec3; clears: boolean } | null {
  if (f.v0.z === 0 || f.p0.z === 0 || Math.sign(f.v0.z) === Math.sign(f.p0.z)) return null;
  const t = -f.p0.z / f.v0.z;
  const pos = positionAt(f, t);
  const touches = pos.y - COURT.ballRadius < COURT.netHeight && Math.abs(pos.x) <= NET_HALF_SPAN;
  return { t, pos, clears: !touches };
}

/**
 * Velocity just after a bounce: vy = -0.75 vy, horizontal x 0.85. Topspin
 * keeps more pace (up to x 0.92), slice bounces lower (vy up to x 0.6).
 * Spin between 0 and +-1 blends linearly.
 */
export function bounceVelocity(v: Vec3, spin: number): Vec3 {
  const top = Math.max(clampSpin(spin), 0);
  const slice = Math.max(-clampSpin(spin), 0);
  const keep = 0.85 + 0.07 * top;
  return vec(v.x * keep, -0.75 * v.y * (1 - 0.4 * slice), v.z * keep);
}

function segmentPosition(s: Segment, t: number): Vec3 {
  if (s.kind === 'air') return positionAt(s, t);
  const k = (1 - Math.exp(-ROLL_DECAY * t)) / ROLL_DECAY;
  return vec(s.p0.x + s.v0.x * k, GROUND_Y, s.p0.z + s.v0.z * k);
}

function segmentVelocity(s: Segment, t: number): Vec3 {
  if (s.kind === 'air') return velocityAt(s, t);
  const k = Math.exp(-ROLL_DECAY * t);
  return vec(s.v0.x * k, 0, s.v0.z * k);
}

/**
 * The whole path of a struck ball: flight, net (the ball drops dead on the
 * hitter's side), and up to `maxBounces` bounces, then it rolls to a stop.
 */
export function buildPath(flight: Flight, maxBounces = 5): BallPath {
  const segments: Segment[] = [];
  const events: PathEvent[] = [];
  let seg: Segment = { ...flight, spin: clampSpin(flight.spin), t0: 0, kind: 'air' };
  segments.push(seg);
  let bounces = 0;
  for (let guard = 0; guard < 16; guard++) {
    const tl = timeToHeight(seg);
    if (!Number.isFinite(tl)) break;
    const cross = netCrossing(seg);
    if (cross && cross.t > 1e-9 && cross.t < tl && !cross.clears) {
      const t = seg.t0 + cross.t;
      events.push({ t, kind: 'net', pos: cross.pos, index: 0 });
      const v = velocityAt(seg, cross.t);
      const side = Math.sign(seg.p0.z);
      seg = {
        p0: vec(cross.pos.x, cross.pos.y, side * (COURT.ballRadius + 0.02)),
        v0: vec(v.x * 0.2, Math.min(v.y, 0) * 0.3, -v.z * 0.1),
        spin: 0, t0: t, kind: 'air',
      };
      segments.push(seg);
      continue;
    }
    const t = seg.t0 + tl;
    const pos = { ...positionAt(seg, tl), y: GROUND_Y };
    bounces++;
    events.push({ t, kind: 'bounce', pos, index: bounces });
    const v = bounceVelocity(velocityAt(seg, tl), seg.spin);
    if (bounces >= maxBounces || v.y < 0.6) {
      segments.push({ p0: pos, v0: vec(v.x, 0, v.z), spin: seg.spin, t0: t, kind: 'roll' });
      break;
    }
    seg = { p0: pos, v0: v, spin: seg.spin, t0: t, kind: 'air' };
    segments.push(seg);
  }
  return { segments, events };
}

function segmentAt(path: BallPath, t: number): Segment {
  let s = path.segments[0];
  for (const next of path.segments) {
    if (next.t0 <= t) s = next;
    else break;
  }
  return s;
}

/** Ball position t seconds after the path started. */
export function pathPosition(path: BallPath, t: number): Vec3 {
  const s = segmentAt(path, t);
  return segmentPosition(s, t - s.t0);
}

/** Ball velocity t seconds after the path started. */
export function pathVelocity(path: BallPath, t: number): Vec3 {
  const s = segmentAt(path, t);
  return segmentVelocity(s, t - s.t0);
}

/** Spin in effect t seconds after the path started. */
export const pathSpin = (path: BallPath, t: number) => segmentAt(path, t).spin;

export const speedKmh = (v: Vec3) => Math.hypot(v.x, v.y, v.z) * 3.6;
