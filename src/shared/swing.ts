import type { RawSample, Swing } from './protocol';
import {
  AxisCalibrator, IDENTITY, RacketAxisLearner, SaturationWatch, applyMap, mapKey,
  type AxisMap,
} from './profile';
import { fixedSpin, isCalibrated, sideOf, spinFrom, type Calibration } from './calibration';

/**
 * Detector thresholds. Set from the first real-phone recording (2026-11-09):
 * peaks of real swings ran 700 to 1342 deg/s; backswings ran 400 to 620 deg/s.
 */
export const TUNING = {
  START: 250,
  MIN_PEAK: 450,
  FULL_POWER: 1400,
  FALL_RATIO: 0.7,
  /** Safety net only: a rise this long ends the candidate. */
  MAX_RISE_MS: 600,
  COOLDOWN_MS: 350,
  /** Complementary filter weight pulling `up` toward the accelerometer at rest. */
  GRAVITY_ALPHA: 0.1,
  GRAVITY_MAX_OMEGA: 150,
  /** Accelerometer readings further than this from 1 g are not trusted as gravity. */
  GRAVITY_TOLERANCE: 2,
  MAX_DT_MS: 50,
  /**
   * Spin is the racket head's upward path at the peak. From three labelled
   * sessions (2026-11-09) a fixed rule beats any running per-player offset:
   * measured flat swings sit between -0.12 and +0.22, so the neutral point is
   * +0.05 and that band is scaled to the +-0.2 "flat" band the game and phone
   * use. (A running median offset was tried and removed: a player who hits
   * mostly topspin had it centred away to flat.)
   */
  SPIN_NEUTRAL: 0.05,
  SPIN_SCALE: 0.2 / 0.17,
};
export type Tuning = typeof TUNING;

const G = 9.81;
const DEG = Math.PI / 180;
/** Wrist to phone distance assumed by the accelerometer-only fallback, in metres. */
const ARM_RADIUS = 0.35;

export type Vector = [number, number, number];
export interface SensorSample {
  t: number;
  accel: Vector;
  /** Rotation rate in deg/s about the phone's x, y and z axes. */
  rotation: Vector;
}
export interface DetectorState {
  phase: 'idle' | 'rising' | 'cooldown';
  /** Unit vector pointing to the sky, in phone coordinates. Tracked by the gyro while moving. */
  up: Vector;
  lastT: number;
  start: number;
  peak: number;
  peakTime: number;
  peakRotation: Vector;
  peakUp: Vector;
  cooldownUntil: number;
}

const normalise = (v: Vector): Vector => {
  const l = Math.hypot(...v);
  return l ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
};
const cross = (a: Vector, b: Vector): Vector =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function createDetector(up: Vector = [0, 0, 1]): DetectorState {
  return {
    phase: 'idle', up: normalise(up), lastT: NaN, start: 0, peak: 0, peakTime: 0,
    peakRotation: [0, 0, 0], peakUp: [0, 0, 1], cooldownUntil: 0,
  };
}

/**
 * Swing features from the rotation vector and `up` at the peak (DESIGN.md
 * section 4). `racket` is the racket direction in phone coordinates.
 */
export function features(rotation: Vector, up: Vector, peak: number, tuning: Tuning = TUNING, racket: Vector = [0, 1, 0]) {
  return {
    power: clamp((peak - tuning.MIN_PEAK) / (tuning.FULL_POWER - tuning.MIN_PEAK), 0, 1),
    // The racket head moves along w x racket; its upward part is the spin.
    spin: clamp(dot(cross(rotation, racket), up) / peak, -1, 1),
    dir: Math.sign(dot(rotation, up)),
  };
}

export function stepDetector(previous: DetectorState, sample: SensorSample, tuning: Tuning = TUNING): {
  state: DetectorState; omega: number; swing?: Swing;
} {
  if (![sample.t, ...sample.accel, ...sample.rotation].every(Number.isFinite)) {
    return { state: previous, omega: 0 };
  }
  const state = { ...previous };
  const omega = Math.hypot(...sample.rotation);

  // Track `up` through the motion: a world-fixed vector seen from the phone turns by -w x v.
  const dt = Number.isFinite(previous.lastT)
    ? Math.min(Math.max(sample.t - previous.lastT, 0), tuning.MAX_DT_MS) / 1000 : 0;
  const w = sample.rotation.map((r) => r * DEG) as Vector;
  const turn = cross(w, previous.up);
  let up = normalise([
    previous.up[0] - turn[0] * dt, previous.up[1] - turn[1] * dt, previous.up[2] - turn[2] * dt,
  ]);
  // At rest, pull it toward the accelerometer so gyro drift cannot build up.
  if (omega < tuning.GRAVITY_MAX_OMEGA && Math.abs(Math.hypot(...sample.accel) - G) < tuning.GRAVITY_TOLERANCE) {
    const a = normalise(sample.accel);
    up = normalise(up.map((u, i) => u + tuning.GRAVITY_ALPHA * (a[i] - u)) as Vector);
  }
  state.up = up;
  state.lastT = sample.t;

  if (state.phase === 'cooldown') {
    if (sample.t < state.cooldownUntil) return { state, omega };
    state.phase = 'idle';
  }
  if (state.phase === 'idle') {
    if (omega <= tuning.START) return { state, omega };
    state.phase = 'rising';
    state.start = sample.t;
    state.peak = 0;
  }
  if (omega > state.peak) {
    state.peak = omega;
    state.peakTime = sample.t;
    state.peakRotation = [...sample.rotation];
    state.peakUp = up;
  }
  const fell = omega < tuning.FALL_RATIO * state.peak;
  const tooLong = sample.t - state.start >= tuning.MAX_RISE_MS;
  if (!fell && !tooLong) return { state, omega };

  if (state.peak <= tuning.MIN_PEAK) {
    // Too gentle to be a swing. No cooldown, so a real swing right after still counts.
    state.phase = 'idle';
    return { state, omega };
  }
  state.phase = 'cooldown';
  state.cooldownUntil = sample.t + tuning.COOLDOWN_MS;
  return { state, omega, swing: {
    tp: state.peakTime,
    omega: state.peak,
    ...features(state.peakRotation, state.peakUp, state.peak, tuning),
    dur: state.peakTime - state.start,
  } };
}

export type Sample = RawSample;
export type { Swing };

/** What a phone has learned about itself; saved on the phone between games. */
export interface SavedProfile {
  v: 1;
  map?: AxisMap;
  racketSum?: Vector;
  racketCount?: number;
  cap?: number | null;
}

export interface ProfileReport {
  mode: 'starting' | 'gyro' | 'accel';
  axes: string;
  axesLearned: boolean;
  axisMoves: number;
  racket: Vector;
  racketSwings: number;
  spinOffset: number;
  gyroCap: number | null;
  /** True while a player's own spin calibration is in use (src/shared/calibration.ts). */
  spinCalibrated: boolean;
}

/**
 * A swing as the phone sees it: the wire swing plus the two spin features the
 * calibration uses. `path` is the upward racket-head path at the peak before
 * the neutral point; `face` is the screen normal's upward part times `dir`.
 * Both are NaN in accelerometer-only mode (no gyroscope). Phone only: strip them with `wireSwing` before sending.
 */
export type PhoneSwing = { t: 'swing' } & Swing & { path: number; face: number };

export function wireSwing({ path: _path, face: _face, ...swing }: PhoneSwing): { t: 'swing' } & Swing {
  return swing;
}

/**
 * The phone's swing reader. Feed it every devicemotion event as the phone
 * reports it; it works out the phone's own conventions as the player swings
 * (src/shared/profile.ts) and needs no setup.
 */
export class SwingDetector {
  /** Samples without a rotation rate before the phone is treated as having no gyro. */
  static readonly GYRO_GRACE = 60;

  private state: DetectorState | undefined;
  private mode: ProfileReport['mode'] = 'starting';
  private noGyro = 0;
  private readonly calibrator: AxisCalibrator;
  private readonly racket = new RacketAxisLearner();
  private readonly saturation = new SaturationWatch();
  private savedMap: AxisMap | undefined;
  private history: { t: number; accel: Vector; up: Vector }[] = [];
  /** A player's own spin calibration; null uses the fixed rule. */
  calibration: Calibration | null = null;

  /** 'starting' until the first rotation rate (gyro) or 60 samples without one (accel). */
  get sensorMode(): ProfileReport['mode'] { return this.mode; }

  constructor(saved?: SavedProfile, private readonly onLearn?: (profile: SavedProfile) => void) {
    this.calibrator = new AxisCalibrator(() => this.onLearn?.(this.save()));
    if (saved?.v === 1) {
      this.savedMap = saved.map;
      if (saved.racketSum && saved.racketCount) this.racket.restore(saved.racketSum, saved.racketCount);
      if (saved.cap) this.saturation.cap = saved.cap;
    }
  }

  /** Learned mapping, else the saved one, else the platform default; with the measured unit as soon as it is known. */
  get map(): AxisMap {
    if (this.calibrator.best) return this.calibrator.best;
    const base = this.savedMap ?? IDENTITY;
    const scale = this.calibrator.scale;
    return scale === null ? base : { ...base, scale };
  }

  /** Thresholds for this phone: scaled down for a gyro that tops out early, or the accelerometer fallback. */
  get tuning(): Tuning {
    if (this.mode === 'accel') return { ...TUNING, START: 300, MIN_PEAK: 520, FULL_POWER: 850, COOLDOWN_MS: 450 };
    const cap = this.saturation.cap;
    if (!cap || cap >= TUNING.FULL_POWER) return TUNING;
    return {
      ...TUNING,
      START: Math.min(TUNING.START, 0.5 * cap),
      MIN_PEAK: Math.min(TUNING.MIN_PEAK, 0.8 * cap),
      FULL_POWER: Math.min(TUNING.FULL_POWER, 1.4 * cap),
    };
  }

  sample(t: number, accel: Vector, native: Vector | null): { raw: RawSample; omega: number; swing?: PhoneSwing } {
    const gyro = native !== null && native.every(Number.isFinite);
    if (gyro) this.mode = 'gyro';
    else if (this.mode === 'starting' && ++this.noGyro >= SwingDetector.GYRO_GRACE) this.mode = 'accel';

    this.state ??= createDetector(accel.every(Number.isFinite) && Math.hypot(...accel) > 0 ? accel : [0, 0, 1]);
    let rotation: Vector;
    if (gyro) {
      this.calibrator.add({ t, accel, native });
      rotation = applyMap(this.map, native);
    } else {
      // No gyro: estimate turn rate from the outward pull of the swing (a = w^2 r),
      // pointed along `up` so it adds no spin and does not turn `up`.
      const up = this.state.up;
      const pull = Math.hypot(...accel.map((a, i) => a - G * up[i]));
      rotation = up.map((u) => u * Math.sqrt(pull / ARM_RADIUS) / DEG) as Vector;
    }

    const tuning = this.tuning;
    const result = stepDetector(this.state, { t, accel, rotation }, tuning);
    this.state = result.state;
    this.history.push({ t, accel, up: this.state.up });
    if (this.history.length > 12) this.history.shift();

    const g = this.state.up.map((u) => u * G);
    const raw: RawSample = [t, ...accel, g[0], g[1], g[2], ...(gyro ? native : [0, 0, 0] as Vector)];
    if (!result.swing) return { raw, omega: result.omega };

    const { peakRotation, peakUp, peak } = this.state;
    // Without a gyroscope there are no spin features: NaN, so the spin teacher rejects these swings.
    let spin = 0, path = NaN, face = NaN;
    if (this.mode === 'gyro') {
      path = features(peakRotation, peakUp, peak, tuning, this.racket.axis).spin;
      face = peakUp[2] * result.swing.dir;
      spin = spinFrom(this.calibration, sideOf(result.swing.dir), path, face,
        fixedSpin(path, tuning.SPIN_NEUTRAL, tuning.SPIN_SCALE));
      this.racket.add(this.history.filter((h) => Math.abs(h.t - result.swing!.tp) <= 25), peakRotation);
      const before = this.saturation.cap;
      this.saturation.add(peakRotation);
      if (this.saturation.cap !== before || this.racket.count === RacketAxisLearner.MIN_SWINGS) this.onLearn?.(this.save());
    }
    return { raw, omega: result.omega, swing: { t: 'swing', ...result.swing, spin, path, face } };
  }

  save(): SavedProfile {
    return {
      v: 1,
      map: this.calibrator.best ?? this.savedMap,
      ...this.racket.snapshot(),
      cap: this.saturation.cap,
    };
  }

  report(): ProfileReport {
    return {
      mode: this.mode,
      axes: mapKey(this.map),
      axesLearned: this.calibrator.best !== null || this.savedMap !== undefined,
      axisMoves: this.calibrator.count,
      racket: this.racket.axis,
      racketSwings: this.racket.count,
      spinOffset: this.tuning.SPIN_NEUTRAL,
      gyroCap: this.saturation.cap,
      spinCalibrated: isCalibrated(this.calibration),
    };
  }
}
