import { SwingDetector, type Vector } from '../shared/swing';
import { gauss, type Rng } from '../engine/rng';

/**
 * Synthetic phone swings for the player simulator (docs/v2/PLAN.md M2).
 *
 * A synthetic swing is a real recorded swing (a template: the raw sensor
 * samples from the stillness before it to the stillness after it) replayed
 * with small, physically consistent changes: a time warp (the same rotation
 * done a little faster or slower), sensor noise and a jittered sample clock.
 * Templates come from the teach and tuning sets only (docs/v2/FIXTURE-SPLIT.md);
 * the held-out set is what the result is checked against.
 *
 * Nothing here changes detection: the streams go through the real
 * SwingDetector, exactly as a phone's samples do.
 */

export type SwingSide = 'fh' | 'bh';
export type SwingKind = 'slice' | 'flat' | 'top';

/** One devicemotion sample as the phone page sees it: acceleration including gravity (m/s^2) and the native rotation rate (deg/s). */
export interface MotionSample { t: number; accel: Vector; rot: Vector | null }

/** One sample of a recording, with the detector's gravity estimate at that moment (the recording keeps it). */
export interface RecordedSample { t: number; accel: Vector; gravity: Vector; rot: Vector }

/** A recorded swing cut out of a session: times are ms relative to the detected peak. */
export interface SwingTemplate {
  id: string;
  side: SwingSide;
  kind: SwingKind;
  session: number;
  /** Position among the labelled swings of its session, in time order (a player's habits drift along it). */
  order: number;
  /** Peak rotation rate in the recording, deg/s. */
  peak: number;
  samples: RecordedSample[];
}

export const TEMPLATE = {
  /** A sample is still when it turns slower than this (deg/s) and the pull is within `stillPull` of 1 g (m/s^2). */
  stillRate: 60,
  stillPull: 2,
  /** Longest stretch kept before and after the peak, ms. */
  maxBefore: 1300,
  maxAfter: 900,
  /** Still samples kept on either end, so a template starts and ends at rest. */
  margin: 4,
};

const G = 9.81;
const norm = (v: Vector) => Math.hypot(v[0], v[1], v[2]);
const lerp3 = (a: Vector, b: Vector, k: number): Vector => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/**
 * Cut one template per labelled swing out of a recording. `peaks` are the
 * detected peak times in the recording's own clock, with their labels.
 */
export function extractTemplates(
  recording: RecordedSample[], peaks: { tp: number; side: SwingSide; kind: SwingKind; id: string; session: number; order: number }[],
): SwingTemplate[] {
  const still = (i: number) => i >= 0 && i < recording.length
    && norm(recording[i].rot) < TEMPLATE.stillRate && Math.abs(norm(recording[i].accel) - G) < TEMPLATE.stillPull;
  const out: SwingTemplate[] = [];
  for (const peak of peaks) {
    let p = 0;
    for (let i = 1; i < recording.length; i++) if (Math.abs(recording[i].t - peak.tp) < Math.abs(recording[p].t - peak.tp)) p = i;
    let from = p;
    while (from > 0 && recording[p].t - recording[from].t < TEMPLATE.maxBefore && !(still(from) && still(from - 1) && still(from - 2))) from--;
    let to = p;
    while (to < recording.length - 1 && recording[to].t - recording[p].t < TEMPLATE.maxAfter && !(still(to) && still(to + 1) && still(to + 2))) to++;
    from = Math.max(0, from - TEMPLATE.margin);
    to = Math.min(recording.length - 1, to + TEMPLATE.margin);
    const samples = recording.slice(from, to + 1).map((s) => ({ ...s, t: s.t - recording[p].t }));
    if (samples.length < 12) continue;
    out.push({ id: peak.id, side: peak.side, kind: peak.kind, session: peak.session, order: peak.order, peak: norm(recording[p].rot), samples });
  }
  return out;
}

export interface SynthOptions {
  /** Time warp: 1.1 is the same rotation done 10% slower (peak rate 10% lower). */
  warp?: number;
  /** Sensor noise, sd: rotation rate (deg/s) and acceleration (m/s^2). */
  rotNoise?: number;
  accelNoise?: number;
  /** Sample rate and the jitter of each sample time (ms, sd). The A32 gives 60 Hz with about 1 ms of jitter. */
  rateHz?: number;
  jitterMs?: number;
}

export const SYNTH_DEFAULTS = { rotNoise: 2, accelNoise: 0.15, rateHz: 60, jitterMs: 1 };

/**
 * Replay a template with its peak at `peakAt`. The warp keeps the motion
 * physical: every angle turned is the same, so gravity is where the gyro says
 * it is; rotation rates scale by 1 / warp and the swing's own acceleration
 * (everything but gravity) by 1 / warp^2.
 */
export function synthSwing(template: SwingTemplate, peakAt: number, rng: Rng, options: SynthOptions = {}): MotionSample[] {
  const o = { ...SYNTH_DEFAULTS, ...options };
  const k = options.warp ?? 1;
  const src = template.samples;
  const first = src[0].t * k;
  const last = src[src.length - 1].t * k;
  const step = 1000 / o.rateHz;
  const out: MotionSample[] = [];
  let j = 0;
  // The grid is laid from the peak outwards so one sample lands near it, as on a phone that samples through the swing.
  const offset = (rng() - 0.5) * step;
  for (let tau = offset - Math.floor((offset - first) / step) * step; tau <= last; tau += step) {
    const at = tau / k;
    while (j < src.length - 2 && src[j + 1].t < at) j++;
    const a = src[j], b = src[Math.min(j + 1, src.length - 1)];
    const f = b.t === a.t ? 0 : Math.max(0, Math.min(1, (at - a.t) / (b.t - a.t)));
    const rot = lerp3(a.rot, b.rot, f);
    const gravity = lerp3(a.gravity, b.gravity, f);
    const accel = lerp3(a.accel, b.accel, f);
    out.push({
      t: peakAt + tau + gauss(rng, o.jitterMs),
      rot: [rot[0] / k + gauss(rng, o.rotNoise), rot[1] / k + gauss(rng, o.rotNoise), rot[2] / k + gauss(rng, o.rotNoise)],
      accel: [0, 1, 2].map((i) => gravity[i] + (accel[i] - gravity[i]) / (k * k) + gauss(rng, o.accelNoise)) as Vector,
    });
  }
  // Sample times must rise, whatever the jitter did.
  for (let i = 1; i < out.length; i++) if (out[i].t <= out[i - 1].t) out[i].t = out[i - 1].t + 0.5;
  return out;
}

/** The phone held still in one pose from `from` to `to` (ms): gravity only, plus sensor noise. */
export function restSamples(pose: Vector, from: number, to: number, rng: Rng, options: SynthOptions = {}): MotionSample[] {
  const o = { ...SYNTH_DEFAULTS, ...options };
  const step = 1000 / o.rateHz;
  const scale = G / (norm(pose) || 1);
  const out: MotionSample[] = [];
  for (let t = from; t < to; t += step) {
    out.push({
      t,
      rot: [gauss(rng, o.rotNoise), gauss(rng, o.rotNoise), gauss(rng, o.rotNoise)],
      accel: [0, 1, 2].map((i) => pose[i] * scale + gauss(rng, o.accelNoise)) as Vector,
    });
  }
  return out;
}

/** The pose a template starts in: its first sample's pull, which is gravity because it starts at rest. */
export const startPose = (template: SwingTemplate): Vector => template.samples[0].gravity;

/**
 * A continuous sensor stream of swings separated by rests, as one phone would
 * produce it. Each swing is preceded by at least `settleMs` of stillness in
 * its starting pose, which is how long the detector takes to find gravity again.
 */
export class SwingStream {
  readonly samples: MotionSample[] = [];
  private end = 0;

  constructor(private readonly rng: Rng, private readonly options: SynthOptions = {}, readonly settleMs = 700) {}

  /** Time the stream has reached, ms. */
  get now(): number { return this.end; }

  /** Add a swing whose peak is at `peakAt` (pushed later if the stream has not left it room). Returns the peak time used. */
  swing(template: SwingTemplate, peakAt: number, warp = 1): number {
    const lead = -template.samples[0].t * warp;
    const at = Math.max(peakAt, this.end + this.settleMs + lead);
    const swing = synthSwing(template, at, this.rng, { ...this.options, warp });
    this.samples.push(...restSamples(startPose(template), this.end, swing[0].t, this.rng, this.options), ...swing);
    this.end = swing[swing.length - 1].t + 1000 / (this.options.rateHz ?? SYNTH_DEFAULTS.rateHz);
    return at;
  }
}

/** What the real detector made of one synthetic swing. */
export interface BankEntry {
  template: string;
  side: SwingSide;
  kind: SwingKind;
  session: number;
  order: number;
  warp: number;
  /** False when the detector reported no swing near the peak. */
  detected: boolean;
  /** Detected peak time minus the intended one, ms. */
  peakOffset: number;
  power: number;
  spin: number;
  omega: number;
  dur: number;
  /** The detected turn direction matches the template's side. */
  dirOk: boolean;
  /** Calibration features at the peak. */
  path: number;
  face: number;
}

export interface BankOptions extends SynthOptions {
  /** Synthetic swings per template. */
  perTemplate?: number;
  /** Time warp range, uniform. */
  warpRange?: [number, number];
  /** Play the templates in recorded order (session, then order), as the player's sessions went; otherwise as given. */
  recordedOrder?: boolean;
}

/**
 * Run synthetic swings through one real SwingDetector, as one phone would
 * across its sessions, and return what it detected for each. This is both the
 * validation data (compare with the held-out recordings) and the bank the
 * simulated players draw their swings from.
 */
export function buildBank(templates: SwingTemplate[], rng: Rng, options: BankOptions = {}): BankEntry[] {
  const per = options.perTemplate ?? 5;
  const [lo, hi] = options.warpRange ?? [0.9, 1.12];
  const list = options.recordedOrder === false ? templates
    : [...templates].sort((a, b) => a.session - b.session || a.order - b.order);
  const detector = new SwingDetector();
  const stream = new SwingStream(rng, options);
  const out: BankEntry[] = [];
  let fed = 0;
  for (let round = 0; round < per; round++) {
    for (const template of list) {
      const warp = lo + (hi - lo) * rng();
      const at = stream.swing(template, stream.now, warp);
      const found: { tp: number; power: number; spin: number; omega: number; dur: number; dir: number; path: number; face: number }[] = [];
      for (; fed < stream.samples.length; fed++) {
        const s = stream.samples[fed];
        const r = detector.sample(s.t, s.accel, s.rot);
        if (r.swing) found.push(r.swing);
      }
      // The swing nearest the intended peak; a backswing that fired earlier is not it.
      const best = found.filter((f) => Math.abs(f.tp - at) < 150).sort((a, b) => b.omega - a.omega)[0];
      const want = template.side === 'fh' ? 1 : -1;
      out.push({
        template: template.id, side: template.side, kind: template.kind, session: template.session, order: template.order, warp,
        detected: !!best, peakOffset: best ? best.tp - at : 0, power: best?.power ?? 0, spin: best?.spin ?? 0,
        omega: best?.omega ?? 0, dur: best?.dur ?? 0, dirOk: best ? best.dir === want : false,
        path: best?.path ?? Number.NaN, face: best?.face ?? Number.NaN,
      });
    }
  }
  return out;
}
