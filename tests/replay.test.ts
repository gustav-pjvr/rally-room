import { describe, expect, it } from 'vitest';
import { SwingDetector } from '../src/shared/swing';
import { loadRecording } from './fixtures/replay';

// Gustav's first real-phone recording, 2026-11-09: 44 s, 60 Hz, mixed swings.
const rec = loadRecording('tests/fixtures/phone-2026-11-09.csv');
const t0 = rec[0].t;
const swings = (() => {
  const d = new SwingDetector();
  return rec.flatMap((s) => d.sample(s.t, s.accel, s.rotation).swing ?? [])
    .map((s) => ({ ...s, at: (s.tp - t0) / 1000 }));
})();
const near = (at: number) => swings.find((s) => Math.abs(s.at - at) < 0.15);

describe('replay of a real recording', () => {
  it('catches the swings the first detector missed after a slow wind-up', () => {
    expect(near(20.18)?.omega).toBeGreaterThan(700);
    expect(near(23.45)?.omega).toBeGreaterThan(700);
  });

  it('does not fire on the gentle backswings before big swings', () => {
    for (const at of [16.08, 27.22, 36.42, 37.16]) expect(near(at)).toBeUndefined();
    expect(near(16.67)?.power).toBeGreaterThan(0.9);
    expect(near(27.73)?.power).toBeGreaterThan(0.8);
  });

  it('reads the true peak instead of cutting a slow swing short', () => {
    expect(near(35.67)?.omega).toBeGreaterThan(1150);
  });

  it('finds a plausible number of swings', () => {
    expect(swings.length).toBeGreaterThanOrEqual(20);
    expect(swings.length).toBeLessThanOrEqual(25);
  });
});
