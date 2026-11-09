import { describe, expect, it } from 'vitest';
import { SwingDetector, TUNING, type Vector } from '../src/shared/swing';

const UP: Vector = [9.81, 0, 0]; // phone x axis points to the sky
const DT = 1000 / 60;

/** Feed a bell-shaped swing whose rotation axis is `axis` and peak is `peak` deg/s. */
function run(detector: SwingDetector, start: number, peak: number, axis: Vector, ms = 300) {
  const swings = [];
  for (let t = 0; t <= ms; t += DT) {
    const k = Math.exp(-(((t - 120) / 45) ** 2)) * peak;
    const r = detector.sample(start + t, UP, [axis[0] * k, axis[1] * k, axis[2] * k]);
    if (r.swing) swings.push(r.swing);
  }
  return swings;
}

function rested() {
  const d = new SwingDetector();
  for (let i = 0; i < 30; i++) d.sample(i * DT, UP, [0, 0, 0]);
  return d;
}

describe('swing detector', () => {
  it('fires once for a flat swing with power from the peak', () => {
    const swings = run(rested(), 1000, 1000, [1, 0, 0]);
    expect(swings).toHaveLength(1);
    const s = swings[0];
    expect(s.t).toBe('swing');
    expect(s.omega).toBeGreaterThan(900);
    expect(s.power).toBeCloseTo((s.omega - TUNING.MIN_PEAK) / (TUNING.FULL_POWER - TUNING.MIN_PEAK), 5);
    expect(Math.abs(s.spin)).toBeLessThan(0.05);
    expect(s.dir).toBe(1);
  });

  it('gives positive spin for low to high and negative for high to low', () => {
    const top = run(rested(), 1000, 1000, [0.8, 0, -0.6])[0];
    const slice = run(rested(), 1000, 1000, [0.8, 0, 0.6])[0];
    expect(top.spin).toBeGreaterThan(0.3);
    expect(slice.spin).toBeLessThan(-0.3);
  });

  it('never fires for slow movement', () => {
    expect(run(rested(), 1000, 350, [1, 0, 0])).toHaveLength(0);
    expect(run(rested(), 1000, 200, [0, 1, 0])).toHaveLength(0);
  });

  it('holds the cooldown after a swing', () => {
    const d = rested();
    expect(run(d, 1000, 1200, [1, 0, 0], 160)).toHaveLength(1);
    // A second burst inside the cooldown window is ignored.
    expect(run(d, 1170, 1200, [1, 0, 0], 100)).toHaveLength(0);
    // Long after the cooldown, a new swing fires again.
    expect(run(d, 3000, 1200, [1, 0, 0])).toHaveLength(1);
  });

  it('reports a raw sample with the gravity estimate at 1 g', () => {
    const r = new SwingDetector().sample(5, UP, [1, 2, 3]);
    expect(r.raw).toEqual([5, 9.81, 0, 0, 9.81, 0, 0, 1, 2, 3]);
  });
});
