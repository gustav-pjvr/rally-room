import { describe, expect, it, vi } from 'vitest';
import { createRng } from '../../src/engine/rng';
import { SwingDetector } from '../../src/shared/swing';
import { SwingStream, buildBank, synthSwing, type BankEntry } from '../../src/sim/swings';
import { labelledSwings, spinWord, type LabelledSwing } from '../fixtures/split';
import { templatesFor } from '../fixtures/templates';

// Whole simulated matches: quick on a free machine, slow when the laptop is busy with other work.
vi.setConfig({ testTimeout: 120_000 });

/**
 * Validation of the synthetic swings (docs/v2/BRIEF.md section 6, PLAN M2):
 * they are built from the teach and tuning sets only and must pass through
 * the real detector with statistics close to the HELD-OUT recordings. The
 * yardstick for "close" is how far the real tuning swings themselves are from
 * the held-out ones: the synthetic swings may not be much further away.
 * If this file fails, the simulator is not to be trusted for tuning.
 */
const real = labelledSwings();
const heldout = real.filter((s) => s.set === 'heldout');
const fitted = real.filter((s) => s.set !== 'heldout');
const templates = templatesFor(['teach', 'tuning']);
const bank = buildBank(templates, createRng(20261110), { perTemplate: 6 });
const detected = bank.filter((b) => b.detected && b.dirOk);

/** Kolmogorov-Smirnov distance between two samples: 0 identical, 1 disjoint. */
function ks(a: number[], b: number[]): number {
  const x = [...a].sort((p, q) => p - q), y = [...b].sort((p, q) => p - q);
  let i = 0, j = 0, d = 0;
  while (i < x.length && j < y.length) {
    const v = Math.min(x[i], y[j]);
    while (i < x.length && x[i] <= v) i++;
    while (j < y.length && y[j] <= v) j++;
    d = Math.max(d, Math.abs(i / x.length - j / y.length));
  }
  return d;
}
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const pct = (n: number, d: number) => `${n}/${d} (${d ? Math.round((100 * n) / d) : 0}%)`;
const accuracy = (list: { kind: string; spin: number }[]) => list.filter((s) => spinWord(s.spin) === s.kind).length / Math.max(1, list.length);
const asSpin = (s: LabelledSwing) => ({ kind: s.kind, spin: s.fixed });

describe('synthetic swings against the held-out recordings', () => {
  it('cuts one template from every teach and tuning swing', () => {
    expect(templates.length).toBe(fitted.length);
    for (const t of templates) {
      expect(t.samples.length).toBeGreaterThan(12);
      expect(t.samples[0].t).toBeLessThan(-100);
      expect(t.samples[t.samples.length - 1].t).toBeGreaterThan(50);
    }
  });

  it('replays an unchanged template to the same swing the recording gave', () => {
    // No warp and no noise: the detector must find the peak where the recording had it, with the same strength.
    let close = 0;
    for (const t of templates.slice(0, 30)) {
      const stream = new SwingStream(createRng(1), { rotNoise: 0, accelNoise: 0, jitterMs: 0 });
      const at = stream.swing(t, 5000, 1);
      const d = new SwingDetector();
      const found = stream.samples.flatMap((s) => { const r = d.sample(s.t, s.accel, s.rot); return r.swing ? [r.swing] : []; });
      const best = found.filter((f) => Math.abs(f.tp - at) < 150).sort((a, b) => b.omega - a.omega)[0];
      if (best && Math.abs(best.omega - t.peak) / t.peak < 0.06 && Math.abs(best.tp - at) <= 20) close++;
    }
    expect(close).toBeGreaterThanOrEqual(27);
  });

  it('is detected as a swing of the right direction nearly every time', () => {
    const found = bank.filter((b) => b.detected);
    console.log(`synthetic swings: ${bank.length} | detected ${pct(found.length, bank.length)} | right direction ${pct(detected.length, found.length)}`);
    // Some slowed-down copies of the weakest recorded swings fall under the detector's threshold, as a soft real swing would.
    expect(found.length / bank.length).toBeGreaterThanOrEqual(0.88);
    expect(detected.length / found.length).toBeGreaterThanOrEqual(0.97);
  });

  it('puts the detected peak where the swing was meant to peak', () => {
    const offsets = detected.map((b) => Math.abs(b.peakOffset)).sort((a, b) => a - b);
    const p95 = offsets[Math.floor(offsets.length * 0.95)];
    console.log(`peak offset: median ${median(offsets).toFixed(1)} ms, 95% within ${p95.toFixed(1)} ms`);
    expect(median(offsets)).toBeLessThanOrEqual(12);
    expect(p95).toBeLessThanOrEqual(40);
  });

  it('has peak rates, power and swing lengths as close to the held-out swings as the real tuning swings are', () => {
    const rows: string[] = [];
    for (const [name, pick] of [
      ['peak rate, deg/s', (s: { omega: number }) => s.omega],
      ['power', (s: { power: number }) => s.power],
      ['rise time, ms', (s: { dur: number }) => s.dur],
    ] as [string, (s: LabelledSwing | BankEntry) => number][]) {
      const h = heldout.map(pick), f = fitted.map(pick), s = detected.map(pick);
      const realGap = ks(f, h), synthGap = ks(s, h);
      rows.push(`${name}: held-out median ${median(h).toFixed(2)}, tuning ${median(f).toFixed(2)}, synthetic ${median(s).toFixed(2)} | KS tuning-heldout ${realGap.toFixed(2)}, synthetic-heldout ${synthGap.toFixed(2)}`);
      expect(synthGap, name).toBeLessThanOrEqual(realGap + 0.12);
    }
    console.log(rows.join('\n'));
  });

  it('reads spin like the real swings: same order, similar accuracy, similar values per label', () => {
    const lines: string[] = [];
    const synthAcc = accuracy(detected), fitAcc = accuracy(fitted.map(asSpin)), heldAcc = accuracy(heldout.map(asSpin));
    lines.push(`spin word accuracy (fixed rule): synthetic ${(synthAcc * 100).toFixed(0)}%, tuning ${(fitAcc * 100).toFixed(0)}%, held-out ${(heldAcc * 100).toFixed(0)}%`);
    expect(Math.abs(synthAcc - fitAcc)).toBeLessThanOrEqual(0.1);
    let synthGap = 0, realGap = 0, labels = 0;
    for (const side of ['fh', 'bh'] as const) {
      const of = (kind: string) => detected.filter((b) => b.side === side && b.kind === kind).map((b) => b.spin);
      expect(mean(of('slice')), `${side}: slice below flat`).toBeLessThan(mean(of('flat')));
      expect(mean(of('top')), `${side}: topspin above flat`).toBeGreaterThan(mean(of('flat')));
      for (const kind of ['slice', 'flat', 'top']) {
        const h = heldout.filter((s) => s.side === side && s.kind === kind).map((s) => s.fixed);
        const f = fitted.filter((s) => s.side === side && s.kind === kind).map((s) => s.fixed);
        if (!h.length) continue;
        synthGap += Math.abs(mean(of(kind)) - mean(h));
        realGap += Math.abs(mean(f) - mean(h));
        labels++;
        lines.push(`  ${side}-${kind}: mean spin held-out ${mean(h).toFixed(2)}, tuning ${mean(f).toFixed(2)}, synthetic ${mean(of(kind)).toFixed(2)}`);
      }
    }
    lines.push(`mean gap to held-out per label: tuning ${(realGap / labels).toFixed(2)}, synthetic ${(synthGap / labels).toFixed(2)}`);
    console.log(lines.join('\n'));
    expect(synthGap / labels).toBeLessThanOrEqual(realGap / labels + 0.1);
  });

  it('keeps gravity where the gyro says it is under a time warp', () => {
    // A slowed swing turns through the same angle: integrating its rotation gives the same total turn.
    const t = templates[10];
    const turn = (samples: { t: number; rot: [number, number, number] | null }[]) => {
      let sum = 0;
      for (let i = 1; i < samples.length; i++) sum += Math.hypot(...samples[i].rot!) * (samples[i].t - samples[i - 1].t) / 1000;
      return sum;
    };
    const quiet = { rotNoise: 0, accelNoise: 0, jitterMs: 0 };
    const plain = turn(synthSwing(t, 0, createRng(1), { ...quiet, warp: 1 }));
    const slow = turn(synthSwing(t, 0, createRng(1), { ...quiet, warp: 1.15 }));
    expect(Math.abs(slow - plain) / plain).toBeLessThan(0.04);
  });
});
