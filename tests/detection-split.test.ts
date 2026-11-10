import { describe, expect, it } from 'vitest';
import { fit, spinFrom } from '../src/shared/calibration';
import { labelledSwings, spinWord, type LabelledSwing, type SplitSet } from './fixtures/split';

/**
 * Detection results on the tuning and held-out sets (docs/v2/FIXTURE-SPLIT.md).
 * BRIEF hard limit 8: any change to detection must beat the fixed rule (73%
 * overall in v1) and the calibration (81%) on the held-out set, or be reverted.
 * The detection code is unchanged in v2, so this test records the reference
 * numbers and guards them against an accidental change.
 */
const all = labelledSwings();
const of = (set: SplitSet) => all.filter((s) => s.set === set);
const pct = (right: number, total: number) => `${right}/${total} (${total ? Math.round((100 * right) / total) : 0}%)`;

const fixedRight = (swings: LabelledSwing[]) => swings.filter((s) => spinWord(s.fixed) === s.kind).length;

/** Calibrate each session on its own teaching swings, as a player would, then score `swings`. */
function calibratedRight(swings: LabelledSwing[]): number {
  let right = 0;
  for (const session of [0, 1, 2]) {
    const cal = fit(of('teach').filter((s) => s.session === session), new Date(0));
    for (const s of swings.filter((x) => x.session === session)) {
      if (spinWord(spinFrom(cal, s.side, s.path, s.face, s.fixed)) === s.kind) right++;
    }
  }
  return right;
}

describe('detection on the tuning and held-out sets', () => {
  it('splits every labelled swing into exactly one set', () => {
    const counts = { teach: of('teach').length, tuning: of('tuning').length, heldout: of('heldout').length };
    console.log(`labelled swings: ${all.length} | teach ${counts.teach}, tuning ${counts.tuning}, held-out ${counts.heldout}`);
    const perLabel = new Map<string, number[]>();
    for (const s of all) {
      const row = perLabel.get(`${s.session} ${s.label}`) ?? [0, 0, 0];
      row[s.set === 'teach' ? 0 : s.set === 'tuning' ? 1 : 2]++;
      perLabel.set(`${s.session} ${s.label}`, row);
    }
    console.log([...perLabel].map(([k, v]) => `  session ${k}: teach ${v[0]}, tuning ${v[1]}, held-out ${v[2]}`).join('\n'));
    expect(counts.teach + counts.tuning + counts.heldout).toBe(all.length);
    expect(counts.heldout).toBeGreaterThanOrEqual(30);
    expect(counts.tuning).toBeGreaterThanOrEqual(counts.heldout);
  });

  it('reports the fixed rule and the calibration on each set', () => {
    const scored = [...of('tuning'), ...of('heldout')];
    const lines = [
      `fixed rule, every labelled swing: ${pct(fixedRight(all), all.length)}`,
      `fixed rule, tuning:   ${pct(fixedRight(of('tuning')), of('tuning').length)}`,
      `fixed rule, held-out: ${pct(fixedRight(of('heldout')), of('heldout').length)}`,
      `calibrated, tuning:   ${pct(calibratedRight(of('tuning')), of('tuning').length)}`,
      `calibrated, held-out: ${pct(calibratedRight(of('heldout')), of('heldout').length)}`,
      `calibrated, tuning and held-out together: ${pct(calibratedRight(scored), scored.length)} against fixed ${pct(fixedRight(scored), scored.length)}`,
    ];
    console.log(lines.join('\n'));
    // v1 reference: 73% for the fixed rule over every labelled swing.
    expect(fixedRight(all) / all.length).toBeGreaterThanOrEqual(0.7);
    // The calibration must not fall below the fixed rule on the swings after it.
    expect(calibratedRight(scored)).toBeGreaterThan(fixedRight(scored));
  });
});
