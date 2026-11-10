import { describe, expect, it } from 'vitest';
import {
  GROUND_Y, accelY, bounceVelocity, buildPath, netCrossing, pathPosition, positionAt, predictLanding,
  timeToHeight, vec, velocityAt,
} from '../../src/engine/physics';
import { COURT } from '../../src/engine/types';

describe('ball physics', () => {
  it('uses a = -(9.81 + 6 spin) and no drag', () => {
    expect(accelY(0)).toBeCloseTo(-9.81, 9);
    expect(accelY(1)).toBeCloseTo(-15.81, 9);
    expect(accelY(-1)).toBeCloseTo(-3.81, 9);
    const f = { p0: vec(1, 1, 10), v0: vec(2, 5, -20), spin: 0.5 };
    const p = positionAt(f, 0.5);
    expect(p.x).toBeCloseTo(2, 9);
    expect(p.z).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(1 + 2.5 - 0.5 * 12.81 * 0.25, 9);
    expect(velocityAt(f, 0.5).y).toBeCloseTo(5 - 12.81 * 0.5, 9);
  });

  it('bounces with vy x -0.75 and horizontal x 0.85; topspin keeps pace, slice stays low', () => {
    const v = vec(4, -10, -20);
    const flat = bounceVelocity(v, 0);
    expect(flat.y).toBeCloseTo(7.5, 9);
    expect(flat.x).toBeCloseTo(3.4, 9);
    expect(flat.z).toBeCloseTo(-17, 9);
    const top = bounceVelocity(v, 1);
    expect(top.z).toBeCloseTo(-18.4, 9);
    expect(top.y).toBeCloseTo(7.5, 9);
    const slice = bounceVelocity(v, -1);
    expect(slice.y).toBeCloseTo(4.5, 9);
    expect(slice.z).toBeCloseTo(-17, 9);
  });

  it('predicts the first landing exactly where the path bounces', () => {
    const f = { p0: vec(0.5, 1, 12), v0: vec(-1, 4, -22), spin: 0.4 };
    const landing = predictLanding(f);
    expect(positionAt(f, landing.t).y).toBeCloseTo(GROUND_Y, 9);
    expect(landing.pos.y).toBe(GROUND_Y);
    const path = buildPath(f);
    const first = path.events[0];
    expect(first.kind).toBe('bounce');
    expect(first.t).toBeCloseTo(landing.t, 9);
    expect(first.pos.z).toBeCloseTo(landing.pos.z, 9);
    // The path is continuous through the bounce and the ball rises after it.
    const before = pathPosition(path, first.t - 1e-6);
    const after = pathPosition(path, first.t + 1e-6);
    expect(Math.abs(before.z - after.z)).toBeLessThan(1e-3);
    expect(pathPosition(path, first.t + 0.1).y).toBeGreaterThan(GROUND_Y);
    // Later bounces come in order and the ball ends up rolling to a stop.
    const times = path.events.map((e) => e.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(path.segments[path.segments.length - 1].kind).toBe('roll');
  });

  it('timeToHeight returns the later root', () => {
    const f = { p0: vec(0, 1, 0), v0: vec(0, 5, 0), spin: 0 };
    const t = timeToHeight(f, 1);
    expect(t).toBeCloseTo(10 / 9.81, 9);
  });

  it('a low ball hits the 0.95 m net and drops on the hitter side', () => {
    const f = { p0: vec(0, 0.6, 10), v0: vec(0, 1.5, -25), spin: 0 };
    const cross = netCrossing(f);
    expect(cross?.clears).toBe(false);
    const path = buildPath(f);
    expect(path.events[0].kind).toBe('net');
    const bounce = path.events.find((e) => e.kind === 'bounce');
    expect(bounce && bounce.pos.z).toBeGreaterThan(0);
  });

  it('a high ball clears the net, and a wide ball passes outside the posts', () => {
    expect(netCrossing({ p0: vec(0, 1, 10), v0: vec(0, 4, -20), spin: 0 })?.clears).toBe(true);
    const wide = netCrossing({ p0: vec(7, 0.5, 10), v0: vec(0, 0, -25), spin: 0 });
    expect(Math.abs(wide!.pos.x)).toBeGreaterThan(COURT.doublesHalfWidth + 0.914);
    expect(wide?.clears).toBe(true);
    expect(netCrossing({ p0: vec(0, 1, 10), v0: vec(0, 4, 20), spin: 0 })).toBeNull();
  });
});
