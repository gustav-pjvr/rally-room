import { SwingDetector } from '../../src/shared/swing';
import type { Kind, Side } from '../../src/shared/calibration';
import { SIDE, loadLabelled } from './phones';

/**
 * The tuning and held-out split of the labelled A32 recordings
 * (docs/v2/FIXTURE-SPLIT.md, DECISIONS D4).
 *
 * The three sessions are replayed in order through one detector, as a phone
 * keeps what it learned between games (the same replay as tests/spin.test.ts).
 * Every detected swing whose turn direction matches its label is one labelled
 * swing. Within each session and label, in time order:
 *   - swings 1 to 3 are `teach`: the calibration's own teaching swings;
 *   - of the rest, the first half (rounded up) is `tuning`;
 *   - the second half is `heldout`.
 * Later swings are held out because a player's "flat" drifts within a session:
 * anything fitted on earlier swings must prove itself on later ones.
 */
export const SESSIONS = [
  'tests/fixtures/phone-a32-labelled-2026-11-09.csv',
  'tests/fixtures/phone-a32-forehand-2026-11-09.csv',
  'tests/fixtures/phone-a32-backhand-2026-11-09.csv',
] as const;

export type SplitSet = 'teach' | 'tuning' | 'heldout';

export interface LabelledSwing {
  session: number;
  label: string;
  side: Side;
  kind: Kind;
  /** Phone time of the peak within its own recording, ms: the swing's identity. */
  tp: number;
  /** Peak rotation rate, deg/s. */
  omega: number;
  power: number;
  dur: number;
  /** Upward head path and face angle at the peak (calibration features). */
  path: number;
  face: number;
  /** The fixed rule's spin. */
  fixed: number;
  set: SplitSet;
}

export const TEACH_PER_LABEL = 3;

let cache: LabelledSwing[] | null = null;

/** Every labelled swing of the three sessions, with its set. */
export function labelledSwings(): LabelledSwing[] {
  if (cache) return cache;
  const d = new SwingDetector();
  const out: LabelledSwing[] = [];
  let offset = 0;
  SESSIONS.forEach((file, session) => {
    const rec = loadLabelled(file);
    const t0 = rec[0].t;
    for (const s of rec) {
      const r = d.sample(offset + s.t - t0, s.accel, s.native);
      if (r.swing && SIDE[s.label] === r.swing.dir) {
        const [side, kind] = s.label.split('-') as [Side, Kind];
        out.push({
          session, label: s.label, side, kind, tp: r.swing.tp - offset + t0, omega: r.swing.omega,
          power: r.swing.power, dur: r.swing.dur, path: r.swing.path, face: r.swing.face, fixed: r.swing.spin,
          set: 'teach',
        });
      }
    }
    offset += rec[rec.length - 1].t - t0 + 60_000;
  });
  const groups = new Map<string, LabelledSwing[]>();
  for (const s of out) {
    const key = `${s.session}:${s.label}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const group of groups.values()) {
    const rest = group.slice(TEACH_PER_LABEL);
    const tuning = Math.ceil(rest.length / 2);
    rest.forEach((s, i) => { s.set = i < tuning ? 'tuning' : 'heldout'; });
  }
  cache = out;
  return out;
}

/** The word a spin value reads as (the bands used on the phone and the host). */
export const spinWord = (spin: number): Kind => (spin > 0.2 ? 'top' : spin < -0.2 ? 'slice' : 'flat');
