import type { Vector } from './swing';

/**
 * Automatic per-device setup (DESIGN.md section 4a). Phones disagree on how
 * they report motion, so nothing here is assumed: each part is learned from
 * the player's own movement, with no setup screen.
 */

const G = 9.81;
const DEG = Math.PI / 180;

export interface AxisMap {
  /** mapped[i] = sign[i] * native[perm[i]] * scale, in deg/s about the phone's x, y, z. */
  perm: [number, number, number];
  sign: [number, number, number];
  scale: number;
}

export const IDENTITY: AxisMap = { perm: [0, 1, 2], sign: [1, 1, 1], scale: 1 };

export function applyMap(map: AxisMap, native: Vector): Vector {
  return [0, 1, 2].map((i) => map.sign[i] * native[map.perm[i]] * map.scale) as Vector;
}

export function mapKey(map: AxisMap): string {
  return `${map.perm.join('')}${map.sign.map((s) => (s > 0 ? '+' : '-')).join('')}${map.scale === 1 ? 'deg' : 'rad'}`;
}

const PERMS: [number, number, number][] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
/** Every axis order and sign, in deg/s. Units are settled separately (UnitsGuess). */
export const CANDIDATES: AxisMap[] = PERMS.flatMap((perm) =>
  [0, 1, 2, 3, 4, 5, 6, 7].map((s) => ({
    perm,
    sign: [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1] as [number, number, number],
    scale: 1,
  })));

const norm = (v: Vector): Vector => {
  const l = Math.hypot(...v);
  return l ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
};
const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angle = (a: Vector, b: Vector) => Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) / DEG;

interface Timed { t: number; accel: Vector; native: Vector }

/**
 * Settles whether the phone reports its rotation rate in deg/s or rad/s.
 * A pull of more than 25 m/s² only happens in a real swing, which turns the
 * phone at several hundred deg/s (about 5 or more rad/s). If the rotation
 * reading at those moments is typically under 40, the unit is rad/s.
 */
export class UnitsGuess {
  static readonly PULL = 25;
  static readonly EVENTS = 3;
  private readings: number[] = [];
  private lastEvent = -Infinity;
  scale: number | null = null;

  add(t: number, accel: Vector, native: Vector): void {
    if (this.scale !== null || Math.hypot(...accel) < UnitsGuess.PULL || t - this.lastEvent < 300) return;
    this.lastEvent = t;
    this.readings.push(Math.hypot(...native));
    if (this.readings.length < UnitsGuess.EVENTS) return;
    const sorted = [...this.readings].sort((a, b) => a - b);
    this.scale = sorted[sorted.length >> 1] < 40 ? 180 / Math.PI : 1;
  }
}

/**
 * Finds how the phone's rotationRate axes line up with its accelerometer
 * axes. Each time the phone goes still, moves, and goes still again, it
 * integrates the gyro under every candidate mapping and checks which one
 * carries gravity from the first still pose to the second. Validated on two
 * real recordings: the right mapping misses by 15 to 34 degrees on average,
 * the next best by 46 to 52 (DESIGN.md section 4a). Android maps the same way
 * on every model, so this is a safety net for other platforms, and the
 * platform default is used until the evidence is strong.
 */
export class AxisCalibrator {
  static readonly MIN_SEGMENTS = 6;
  static readonly MAX_MEAN_ERROR = 40;
  static readonly MIN_MARGIN = 12;
  static readonly MIN_TURN = 30;
  static readonly STILL_DEG_S = 60;
  static readonly MAX_SEGMENT_MS = 2500;

  private errors = new Float64Array(CANDIDATES.length);
  private segments = 0;
  private quiet = 0;
  private lastStill: Timed | null = null;
  private path: Timed[] | null = null;
  readonly units = new UnitsGuess();
  best: AxisMap | null = null;

  constructor(private readonly onLock?: (map: AxisMap) => void) {}

  get count() { return this.segments; }

  /** The unit factor once known (1 for deg/s), else null. */
  get scale() { return this.units.scale; }

  add(sample: Timed): void {
    if (![sample.t, ...sample.accel, ...sample.native].every(Number.isFinite)) return;
    this.units.add(sample.t, sample.accel, sample.native);
    const scale = this.units.scale;
    if (scale === null) return; // "still" is judged from the gyro, so wait for the unit
    const s = { ...sample, native: sample.native.map((v) => v * scale) as Vector };

    this.quiet = Math.hypot(...s.native) < AxisCalibrator.STILL_DEG_S ? this.quiet + 1 : 0;
    const still = this.quiet >= 5 && Math.abs(Math.hypot(...s.accel) - G) < 1.5;

    if (!still) {
      if (this.lastStill) {
        this.path ??= [this.lastStill];
        this.path.push(s);
        if (s.t - this.path[0].t > AxisCalibrator.MAX_SEGMENT_MS) { this.path = null; this.lastStill = null; }
      }
      return;
    }
    if (this.path) {
      this.path.push(s);
      if (angle(this.path[0].accel, s.accel) >= AxisCalibrator.MIN_TURN) this.finish(this.path, s);
      this.path = null;
    }
    this.lastStill = s;
  }

  private finish(path: Timed[], end: Timed) {
    const target = norm(end.accel);
    CANDIDATES.forEach((map, c) => {
      let up = norm(path[0].accel);
      for (let i = 1; i < path.length; i++) {
        const dt = Math.min(Math.max(path[i].t - path[i - 1].t, 0), 50) / 1000;
        const w = applyMap(map, path[i].native).map((r) => r * DEG) as Vector;
        up = norm([
          up[0] - (w[1] * up[2] - w[2] * up[1]) * dt,
          up[1] - (w[2] * up[0] - w[0] * up[2]) * dt,
          up[2] - (w[0] * up[1] - w[1] * up[0]) * dt,
        ]);
      }
      this.errors[c] += angle(up, target);
    });
    this.segments++;
    this.decide();
  }

  private decide() {
    if (this.segments < AxisCalibrator.MIN_SEGMENTS || this.units.scale === null) return;
    const ranked = [...this.errors].map((e, i) => [e / this.segments, i]).sort((a, b) => a[0] - b[0]);
    const [[bestErr, bestIdx], [secondErr]] = ranked;
    if (bestErr > AxisCalibrator.MAX_MEAN_ERROR || secondErr - bestErr < AxisCalibrator.MIN_MARGIN) return;
    const map = { ...CANDIDATES[bestIdx], scale: this.units.scale };
    if (!this.best || mapKey(this.best) !== mapKey(map)) {
      this.best = map;
      this.onLock?.(map);
    }
  }

  /** Mean error per candidate so far, best first (for the lab and tests). */
  ranking(): { key: string; error: number }[] {
    if (!this.segments) return [];
    return [...this.errors].map((e, i) => ({ key: mapKey(CANDIDATES[i]), error: e / this.segments }))
      .sort((a, b) => a.error - b.error);
  }
}

/**
 * Learns the racket direction in phone coordinates from the outward pull of
 * each swing. A swinging phone is pulled away from the wrist, so the
 * accelerometer (minus gravity) points back toward the wrist; the racket
 * points the other way. Learning it absorbs grip, how the phone sits in the
 * hand, and a phone whose accelerometer has the opposite sign.
 */
export class RacketAxisLearner {
  static readonly MIN_PULL = 15;
  static readonly MIN_SWINGS = 3;
  private sum: Vector = [0, 0, 0];
  count = 0;

  /** `accel` and `up` around the swing peak; `rotation` in deg/s at the peak. */
  add(samples: { accel: Vector; up: Vector }[], rotation: Vector): void {
    let pull: Vector = [0, 0, 0];
    for (const s of samples) pull = pull.map((p, i) => p + s.accel[i] - G * s.up[i]) as Vector;
    pull = pull.map((p) => p / Math.max(samples.length, 1)) as Vector;
    const w = norm(rotation);
    const along = dot(pull, w);
    const across = pull.map((p, i) => p - along * w[i]) as Vector;
    if (Math.hypot(...across) < RacketAxisLearner.MIN_PULL) return;
    const axis = norm(across.map((p) => -p) as Vector);
    this.sum = this.sum.map((s, i) => s + axis[i]) as Vector;
    this.count++;
  }

  get axis(): Vector {
    return this.count >= RacketAxisLearner.MIN_SWINGS ? norm(this.sum) : [0, 1, 0];
  }

  restore(sum: Vector, count: number): void {
    if (sum.every(Number.isFinite) && Number.isFinite(count) && count > 0) {
      // Keep at most 20 swings of weight, so a new grip can still win.
      const k = Math.min(1, 20 / count);
      this.sum = sum.map((v) => v * k) as Vector;
      this.count = Math.round(count * k);
    }
  }

  snapshot(): { racketSum: Vector; racketCount: number } {
    return { racketSum: [...this.sum] as Vector, racketCount: this.count };
  }
}

/** Removes a player's personal spin offset: their median spin, limited to +-0.25. */
export class SpinBaseline {
  static readonly WINDOW = 25;
  static readonly MIN_SWINGS = 6;
  static readonly LIMIT = 0.25;
  private recent: number[] = [];

  add(spin: number): void {
    this.recent.push(spin);
    if (this.recent.length > SpinBaseline.WINDOW) this.recent.shift();
  }

  get value(): number {
    if (this.recent.length < SpinBaseline.MIN_SWINGS) return 0;
    const sorted = [...this.recent].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return Math.max(-SpinBaseline.LIMIT, Math.min(SpinBaseline.LIMIT, median));
  }
}

/**
 * Notices a gyro that tops out early: three or more swings whose largest
 * single-axis rate sits within 1% of the same maximum.
 */
export class SaturationWatch {
  private peaks: number[] = [];
  cap: number | null = null;

  add(rotation: Vector): void {
    this.peaks.push(Math.max(...rotation.map(Math.abs)));
    if (this.peaks.length > 30) this.peaks.shift();
    const max = Math.max(...this.peaks);
    const atMax = this.peaks.filter((p) => p >= max * 0.99).length;
    this.cap = atMax >= 3 ? max : null;
  }
}
