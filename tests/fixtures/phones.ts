import { readFileSync } from 'node:fs';
import { SwingDetector, type Vector } from '../../src/shared/swing';

/** Gustav's labelled Samsung A32 recording (2026-11-09), native rotationRate order alpha, beta, gamma. */
export interface Labelled { t: number; accel: Vector; native: Vector; label: string }

export function loadLabelled(path = 'tests/fixtures/phone-a32-labelled-2026-11-09.csv'): Labelled[] {
  return readFileSync(path, 'utf8').trim().split('\n').slice(1)
    .map((line) => line.split(','))
    .filter((c) => c[0] === 'raw')
    .map((c) => ({
      t: +c[2], accel: [+c[4], +c[5], +c[6]] as Vector, native: [+c[10], +c[11], +c[12]] as Vector, label: c[18],
    }));
}

/** A make-believe phone: how it would report the same physical motion. */
export interface FakePhone {
  name: string;
  /** native_out[i] = sign[i] * x[perm[i]] / unit, where x is the true rate about x, y, z in deg/s. */
  perm?: [number, number, number];
  sign?: [number, number, number];
  radians?: boolean;
  flipAccel?: boolean;
  gyroCap?: number;
  noGyro?: boolean;
}

export function asPhone(rec: Labelled[], phone: FakePhone): (Omit<Labelled, 'native'> & { native: Vector | null })[] {
  const perm = phone.perm ?? [0, 1, 2];
  const sign = phone.sign ?? [1, 1, 1];
  return rec.map((s) => {
    const accel = (phone.flipAccel ? s.accel.map((a) => -a) : s.accel) as Vector;
    if (phone.noGyro) return { ...s, accel, native: null };
    let x = s.native;
    if (phone.gyroCap) x = x.map((v) => Math.max(-phone.gyroCap!, Math.min(phone.gyroCap!, v))) as Vector;
    const out = [0, 1, 2].map((i) => sign[i] * x[perm[i]] * (phone.radians ? Math.PI / 180 : 1)) as Vector;
    return { ...s, accel, native: out };
  });
}

export const SIDE: Record<string, number> = {
  'fh-flat': 1, 'fh-top': 1, 'fh-slice': 1, 'bh-flat': -1, 'bh-top': -1, 'bh-slice': -1,
};

/** Runs a detector over a recording and scores spin against the labels. */
export function play(rec: (Omit<Labelled, 'native'> & { native: Vector | null })[]) {
  const d = new SwingDetector();
  const swings = rec.flatMap((s) => {
    const r = d.sample(s.t, s.accel, s.native);
    return r.swing ? [{ ...r.swing, label: s.label }] : [];
  });
  // Score the second half only, once the phone has had time to learn itself.
  const scored = swings.slice(Math.floor(swings.length / 2)).filter((s) => SIDE[s.label] !== undefined);
  const right = scored.filter((s) =>
    (s.label.endsWith('top') && s.spin > 0.15) || (s.label.endsWith('slice') && s.spin < -0.15)
    || (s.label.endsWith('flat') && Math.abs(s.spin) <= 0.3)).length;
  return { swings, report: d.report(), spinAccuracy: scored.length ? right / scored.length : 0, scored: scored.length };
}
