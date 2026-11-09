import { describe, expect, it } from 'vitest';
import { GROUND_Y, buildPath, predictLanding, vec } from '../../src/host/game/physics';
import { createRng, uniform } from '../../src/host/game/rng';
import { NET_CLEARANCE, heightAtNet, solveShot } from '../../src/host/game/solver';
import { COURT } from '../../src/host/game/types';

describe('shot solver', () => {
  it('lands exactly on the target and clears the net by 0.15 m (1000 random shots)', () => {
    const rng = createRng(42);
    for (let i = 0; i < 1000; i++) {
      const near = rng() < 0.5;
      const s = near ? 1 : -1;
      const p0 = vec(uniform(rng, -5, 5), uniform(rng, 0.1, 2.9), s * uniform(rng, 0.5, 14));
      const target = vec(uniform(rng, -5.5, 5.5), GROUND_Y, -s * uniform(rng, 0.5, 11.9));
      const T = uniform(rng, 0.4, 1.8);
      const spin = uniform(rng, -1, 1);
      const shot = solveShot(p0, target, T, spin);
      expect(shot.T).toBeGreaterThanOrEqual(T);
      const flight = { p0, v0: shot.v0, spin };
      const landing = predictLanding(flight);
      expect(landing.t).toBeCloseTo(shot.T, 6);
      expect(landing.pos.x).toBeCloseTo(target.x, 6);
      expect(landing.pos.z).toBeCloseTo(target.z, 6);
      expect(heightAtNet(p0, shot.v0, spin)!).toBeGreaterThanOrEqual(COURT.netHeight + NET_CLEARANCE - 1e-9);
      expect(buildPath(flight).events[0].kind).toBe('bounce');
    }
  });

  it('keeps the asked flight time when the arc already clears', () => {
    const p0 = vec(0, 1, 12);
    const target = vec(0, GROUND_Y, -9);
    const shot = solveShot(p0, target, 1.4, 0);
    expect(shot.T).toBe(1.4);
  });

  it('raises a flat shot from low contact in 5% steps', () => {
    const p0 = vec(0, 0.3, 3);
    const target = vec(1, GROUND_Y, -3);
    const shot = solveShot(p0, target, 0.2, 1);
    expect(shot.T).toBeGreaterThan(0.2);
    const steps = Math.log(shot.T / 0.2) / Math.log(1.05);
    expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6);
    // One step less would not have cleared.
    const lower = solveShot(p0, target, shot.T / 1.05, 1, -Infinity);
    expect(heightAtNet(p0, lower.v0, 1)!).toBeLessThan(COURT.netHeight + NET_CLEARANCE);
  });
});
