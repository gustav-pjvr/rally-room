import { describe, expect, it } from 'vitest';
import { SwingDetector } from '../src/shared/swing';
import { SIDE, loadLabelled } from './fixtures/phones';

/**
 * Spin labels against Gustav's labelled sessions (Samsung A32, 2026-11-09).
 * The sessions are replayed through ONE detector in order, as a real phone
 * keeps its learned racket axis between games. The old running per-player
 * offset labelled 64% of the match-style swings correctly; the fixed rule
 * must do clearly better and must not depend on swing order.
 */
const FILES = [
  'tests/fixtures/phone-a32-labelled-2026-11-09.csv',
  'tests/fixtures/phone-a32-forehand-2026-11-09.csv',
  'tests/fixtures/phone-a32-backhand-2026-11-09.csv',
];
const word = (spin: number) => (spin > 0.2 ? 'top' : spin < -0.2 ? 'slice' : 'flat');

const swings = (() => {
  const d = new SwingDetector();
  const out: { session: number; label: string; spin: number }[] = [];
  let offset = 0;
  FILES.forEach((file, session) => {
    const rec = loadLabelled(file);
    const t0 = rec[0].t;
    for (const s of rec) {
      const r = d.sample(offset + s.t - t0, s.accel, s.native);
      if (r.swing && SIDE[s.label] === r.swing.dir) out.push({ session, label: s.label, spin: r.swing.spin });
    }
    offset += rec[rec.length - 1].t - t0 + 60_000;
  });
  return out;
})();
const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

describe('spin labels on real labelled swings', () => {
  it('labels at least 70% of all labelled swings correctly', () => {
    const right = swings.filter((s) => s.label.endsWith(word(s.spin))).length;
    expect(swings.length).toBeGreaterThan(100);
    expect(right / swings.length).toBeGreaterThanOrEqual(0.7);
  });

  it('match-style sessions do better than the 64% the old offset gave live', () => {
    const match = swings.filter((s) => s.session > 0);
    expect(match.filter((s) => s.label.endsWith(word(s.spin))).length / match.length).toBeGreaterThan(0.7);
  });

  it('orders slice below flat below topspin on average, per side and session', () => {
    for (const session of [0, 1, 2]) {
      for (const side of ['fh', 'bh']) {
        const of = (kind: string) => swings.filter((s) => s.session === session && s.label === `${side}-${kind}`).map((s) => s.spin);
        const [slice, flat, top] = [of('slice'), of('flat'), of('top')];
        if (!slice.length || !flat.length || !top.length) continue;
        expect(avg(slice), `session ${session} ${side}: slice below flat`).toBeLessThan(avg(flat));
        expect(avg(top), `session ${session} ${side}: topspin above flat`).toBeGreaterThan(avg(flat));
      }
    }
  });

  it('does not depend on swing order: topspin recorded after ten flats still reads as topspin', () => {
    const tops = swings.filter((s) => s.session === 1 && s.label === 'fh-top');
    expect(tops.filter((s) => word(s.spin) === 'top').length / tops.length).toBeGreaterThanOrEqual(0.6);
  });
});
