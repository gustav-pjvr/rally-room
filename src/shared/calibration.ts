/**
 * Optional per-player spin calibration (DESIGN.md section 4, "Spin calibration").
 * Pure: no DOM, no storage. The phone collects a few labelled swings per kind
 * and side, `fit` turns them into class means, and `spinFrom` maps a new swing
 * onto the same -1..1 scale the fixed rule uses, so the +-0.2 word bands hold.
 */

export type Side = 'fh' | 'bh';
export type Kind = 'slice' | 'flat' | 'top';
export const KINDS: readonly Kind[] = ['slice', 'flat', 'top'];

/** One labelled swing: `path` is the raw upward head path, `face` the screen normal's upward part times dir. */
export interface LabelledSwing { side: Side; kind: Kind; path: number; face: number }

type Point = [number, number];

/** Class means in raw feature units and the pooled within-class standard deviation per feature. */
export interface SideCalibration { slice: Point; flat: Point; top: Point; sd: Point }

export interface Calibration {
  v: 1;
  fh: SideCalibration | null;
  bh: SideCalibration | null;
  /** ISO date of the fit. */
  at: string;
}

/** Fewest labelled swings of each kind, per side, for that side to be calibrated. */
export const MIN_PER_KIND = 2;
/** Smallest usable spread (raw units) and smallest distance between class means (in sd units). */
const MIN_SD = 1e-4;
const MIN_GAP = 1e-3;

/** The fixed rule (used whenever a side is not calibrated): neutral point and scale from TUNING. */
export function fixedSpin(path: number, neutral = 0.05, scale = 0.2 / 0.17): number {
  return Number.isFinite(path) ? clamp((path - neutral) * scale, -1, 1) : 0;
}

/**
 * The physical side of a swing: `dir` +1 is 'fh', -1 is 'bh'. This is the turn direction, not the stroke:
 * features and storage use it. A left-hander's forehand turns the other way (see `handSide`).
 */
export function sideOf(dir: number): Side | null {
  return dir > 0 ? 'fh' : dir < 0 ? 'bh' : null;
}

/** Maps a stroke (forehand or backhand) to the physical side for a hand, and back: its own inverse. */
export function handSide(side: Side, leftHanded: boolean): Side {
  return leftHanded ? (side === 'fh' ? 'bh' : 'fh') : side;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const finite = (...v: number[]) => v.every(Number.isFinite);
const isPoint = (v: unknown): v is Point =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && finite(v[0], v[1]);

function fitSide(samples: LabelledSwing[]): SideCalibration | null {
  const groups = KINDS.map((kind) => samples.filter((s) => s.kind === kind && finite(s.path, s.face)));
  if (groups.some((g) => g.length < MIN_PER_KIND)) return null;
  const means = groups.map((g) => [
    g.reduce((a, s) => a + s.path, 0) / g.length,
    g.reduce((a, s) => a + s.face, 0) / g.length,
  ] as Point);
  // Pooled within-class variance: squared deviations from each class mean, over N - K.
  const n = groups.reduce((a, g) => a + g.length, 0);
  const ss: Point = [0, 0];
  groups.forEach((g, k) => g.forEach((s) => {
    ss[0] += (s.path - means[k][0]) ** 2;
    ss[1] += (s.face - means[k][1]) ** 2;
  }));
  const sd: Point = [Math.sqrt(ss[0] / (n - KINDS.length)), Math.sqrt(ss[1] / (n - KINDS.length))];
  const side: SideCalibration = { slice: means[0], flat: means[1], top: means[2], sd };
  return usable(side) ? side : null;
}

/** False for a side that cannot give a sensible spin: bad numbers, no spread, or flat on top of slice or topspin. */
function usable(c: SideCalibration): boolean {
  if (![c.slice, c.flat, c.top, c.sd].every(isPoint)) return false;
  if (!(c.sd[0] > MIN_SD && c.sd[1] > MIN_SD)) return false;
  const [s, f, t] = [z(c, c.slice), z(c, c.flat), z(c, c.top)];
  return dist2(s, f) > MIN_GAP && dist2(t, f) > MIN_GAP;
}

const z = (c: SideCalibration, p: Point): Point => [p[0] / c.sd[0], p[1] / c.sd[1]];
const dist2 = (a: Point, b: Point) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** Standardised nearest class mean per side. A side without two swings of every kind stays on the fixed rule. */
export function fit(samples: LabelledSwing[], now: Date = new Date()): Calibration {
  return {
    v: 1,
    fh: fitSide(samples.filter((s) => s.side === 'fh')),
    bh: fitSide(samples.filter((s) => s.side === 'bh')),
    at: now.toISOString(),
  };
}

export function isCalibrated(cal: Calibration | null | undefined): boolean {
  return !!cal && (!!cal.fh || !!cal.bh);
}

/**
 * Where a parameter along one arm of the line (0 at the flat mean, 1 at the
 * class mean) lands on the spin scale: the midpoint is the word boundary (0.2),
 * the class mean 0.6, then on in a straight line, clamped to 1.
 */
const band = (u: number) => (u <= 0.5 ? 0.4 * Math.max(u, 0) : Math.min(1, 0.2 + 0.8 * (u - 0.5)));

/**
 * Spin for one swing. The standardised point is projected onto the line from
 * the slice mean through the flat mean to the topspin mean: the flat mean
 * reads 0, halfway to topspin +0.2, the topspin mean +0.6 (and the same
 * mirrored for slice). Halfway is where nearest class mean changes its answer,
 * so the phone's word bands agree with the classifier. Not calibrated for that
 * side, or anything degenerate: `fixed` (the fixed rule).
 */
export function spinFrom(cal: Calibration | null | undefined, side: Side | null, path: number, face: number, fixed = fixedSpin(path)): number {
  const c = cal && side ? cal[side] : null;
  if (!c || !finite(path, face) || !usable(c)) return fixed;
  const p = z(c, [path, face]), f = z(c, c.flat), t = z(c, c.top), s = z(c, c.slice);
  const along = (end: Point) => ((p[0] - f[0]) * (end[0] - f[0]) + (p[1] - f[1]) * (end[1] - f[1])) / dist2(end, f);
  // The arm is the nearer of the two class means, by real distance, so the word is nearest class mean
  // exactly (comparing the two projections is wrong when the arms are unequal or not opposite).
  const spin = dist2(p, t) <= dist2(p, s) ? band(along(t)) : -band(along(s));
  return Number.isFinite(spin) ? spin : fixed;
}

/** A calibration read back from storage, or null when it is not one. */
export function asCalibration(value: unknown): Calibration | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (c.v !== 1 || typeof c.at !== 'string') return null;
  const side = (s: unknown): SideCalibration | null => {
    if (!s || typeof s !== 'object') return null;
    const o = s as Record<string, unknown>;
    if (![o.slice, o.flat, o.top, o.sd].every(isPoint)) return null;
    const out = { slice: o.slice, flat: o.flat, top: o.top, sd: o.sd } as SideCalibration;
    return usable(out) ? out : null;
  };
  const out: Calibration = { v: 1, fh: side(c.fh), bh: side(c.bh), at: c.at };
  return isCalibrated(out) ? out : null;
}

/** The storage key for a player's name on this phone: lower case, trimmed, inner spaces collapsed. */
export function playerKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The steps of the phone's teaching flow, in order. */
export const STEPS: readonly { side: Side; kind: Kind }[] = [
  { side: 'fh', kind: 'slice' }, { side: 'fh', kind: 'flat' }, { side: 'fh', kind: 'top' },
  { side: 'bh', kind: 'slice' }, { side: 'bh', kind: 'flat' }, { side: 'bh', kind: 'top' },
];
export const SWINGS_PER_STEP = 3;

/**
 * The teaching flow as a small state machine, so the phone UI only renders it.
 * Steps are named by stroke (forehand, backhand). A left-hander's forehand turns the
 * other way, so `leftHanded` maps each stroke to the physical turn direction; samples are
 * stored under that physical side, the same one `spinFrom` is given at play time.
 * Swings the other way round (a follow-through) and swings without finite features
 * (a phone without a gyroscope) are ignored.
 */
export class Teacher {
  private samples: LabelledSwing[] = [];
  private wentBack = false;
  step = 0;

  constructor(private readonly leftHanded = false) {}

  get current() { return STEPS[this.step] ?? null; }
  get done(): boolean { return this.step >= STEPS.length; }
  /** The `dir` the current step expects: +1 or -1, or 0 when finished. */
  get expectedDir(): number {
    const c = this.current;
    return c ? (handSide(c.side, this.leftHanded) === 'fh' ? 1 : -1) : 0;
  }
  /** Swings counted in the current step. */
  get count(): number {
    const c = this.current;
    if (!c) return 0;
    const side = handSide(c.side, this.leftHanded);
    return this.samples.filter((s) => s.side === side && s.kind === c.kind).length;
  }
  /** Going back is allowed one step: after a go-back, only that step can be redone until it is finished. */
  get canRedo(): boolean { return this.count > 0 || (this.step > 0 && !this.wentBack); }
  get redoLabel(): 'Redo the last step' | 'Redo this step' {
    return this.count === 0 && this.step > 0 && !this.wentBack ? 'Redo the last step' : 'Redo this step';
  }

  /** Returns true when the swing counted. */
  add(dir: number, path: number, face: number): boolean {
    const c = this.current;
    const side = sideOf(dir);
    if (!c || !side || side !== handSide(c.side, this.leftHanded) || !finite(path, face)) return false;
    this.samples.push({ side, kind: c.kind, path, face });
    // A go-back is spent until the step is finished, so redo, swing, redo cycles
    // can never walk further back than one step.
    if (this.count >= SWINGS_PER_STEP) { this.step++; this.wentBack = false; }
    return true;
  }

  redo() {
    // Redo the step in progress; on a fresh step (nothing counted yet) go back to the one before it,
    // once: a second tap before a swing counts does nothing, so earlier steps are never wiped.
    if (!this.canRedo) return;
    if (this.count === 0) { this.step--; this.wentBack = true; }
    const c = this.current;
    if (!c) return;
    const side = handSide(c.side, this.leftHanded);
    this.samples = this.samples.filter((s) => s.side !== side || s.kind !== c.kind);
  }

  result(now?: Date): Calibration { return fit(this.samples, now); }
}
