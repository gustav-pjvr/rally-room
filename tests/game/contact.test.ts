import { describe, expect, it } from 'vitest';
import {
  CONTACT, SWEET_SPOT, alongFromTiming, classify, heightPush, locateContact, locateServeContact, reachAwkwardness,
  rushedFrom, shank, strikeEffect, sweetDistance, tiltLaunch, type ContactInput,
} from '../../src/host/game/contact';
import { createRng } from '../../src/host/game/rng';

/** gauss() with this source returns (almost exactly) 0: cos(2 pi 0.25) = 0. A noise-free contact. */
const still = () => 0.25;
const calm: ContactInput = { u: 0, spin: 0.3, height: 1.0, rushed: 0, lateral: 0.55 };

describe('contact: face geometry', () => {
  it('measures distance from the sweet spot to the rim: 0 at the sweet spot, 1 on the rim in every direction', () => {
    expect(sweetDistance(SWEET_SPOT.a, SWEET_SPOT.b)).toBeCloseTo(0, 9);
    for (const angle of [0, 0.7, Math.PI / 2, 2, Math.PI, 4, 5.5]) {
      expect(sweetDistance(Math.cos(angle), Math.sin(angle))).toBeCloseTo(1, 9);
    }
    // Halfway to the tip and halfway to the throat.
    expect(sweetDistance(SWEET_SPOT.a + 0.575, 0)).toBeCloseTo(0.5, 9);
    expect(sweetDistance(SWEET_SPOT.a - 0.425, 0)).toBeCloseTo(0.5, 9);
  });

  it('classifies bed, frame (1 < r <= 1.25) and miss', () => {
    expect(classify(-0.15, 0)).toMatchObject({ kind: 'bed', quality: 1 });
    expect(classify(0.6, 0.6).kind).toBe('bed');
    for (const r of [1.01, 1.1, 1.25]) {
      const c = classify(-r, 0);
      expect(c.kind, `r ${r}`).toBe('frame');
      expect(c.quality).toBe(CONTACT.frameQuality);
    }
    expect(classify(0, 1.26).kind).toBe('miss');
    expect(classify(-1.3, 0)).toMatchObject({ kind: 'miss', quality: 0 });
  });

  it('quality is 1 - d inside the bed', () => {
    const c = classify(0.425, 0);
    expect(c.d).toBeCloseTo(0.5, 9);
    expect(c.quality).toBeCloseTo(0.5, 9);
  });
});

describe('contact: where the ball lands on the face', () => {
  it('a centred swing meets the sweet spot: d near 0 and full power transfer', () => {
    const c = locateContact(calm, still);
    expect(c.a).toBeCloseTo(SWEET_SPOT.a, 6);
    expect(c.b).toBeCloseTo(0, 6);
    expect(c.d).toBeLessThan(1e-6);
    expect(c.quality).toBeCloseTo(1, 6);
    const fx = strikeEffect(c, 1, 0.6, 0.3, still);
    expect(fx.transfer).toBeCloseTo(1, 9);
    expect(fx.dx).toBeCloseTo(0, 9);
    expect(fx.ddepth).toBeCloseTo(0, 9);
    expect(fx.tilt).toBe(0);
  });

  it('early goes toward the tip (a > 0), late toward the throat (a < sweet spot)', () => {
    expect(locateContact({ ...calm, u: -0.8 }, still).a).toBeGreaterThan(0.5);
    expect(locateContact({ ...calm, u: 0.8 }, still).a).toBeLessThan(-0.6);
    // The bed edge falls near the old window edge |u| = 1 on both sides.
    expect(alongFromTiming(-1.15)).toBeCloseTo(1, 9);
    expect(alongFromTiming(1.1333)).toBeCloseTo(-1, 3);
    // Same with noise, on average.
    const rng = createRng(3);
    let early = 0, late = 0;
    for (let i = 0; i < 400; i++) {
      early += locateContact({ ...calm, u: -0.6 }, rng).a;
      late += locateContact({ ...calm, u: 0.6 }, rng).a;
    }
    expect(early / 400).toBeGreaterThan(0.3);
    expect(late / 400).toBeLessThan(-0.45);
  });

  it('a topspin swing met early sits high on the face (b > 0), late low (b < 0); slice the other way', () => {
    expect(locateContact({ ...calm, u: -0.8, spin: 0.8 }, still).b).toBeGreaterThan(0.3);
    expect(locateContact({ ...calm, u: 0.8, spin: 0.8 }, still).b).toBeLessThan(-0.3);
    expect(locateContact({ ...calm, u: -0.8, spin: -0.8 }, still).b).toBeLessThan(-0.3);
    expect(locateContact({ ...calm, u: 0, spin: 1 }, still).b).toBeCloseTo(0, 6);
  });

  it('awkward heights push the ball toward that edge', () => {
    expect(heightPush(1.0)).toBe(0);
    expect(heightPush(0.2)).toBeLessThan(0);
    expect(heightPush(2.0)).toBeGreaterThan(0);
    expect(locateContact({ ...calm, height: 0.1 }, still).b).toBeLessThan(-0.3);
  });

  it('rushed, stretched or jammed contacts scatter more', () => {
    expect(reachAwkwardness(0.55)).toBe(0);
    expect(reachAwkwardness(1.8)).toBe(1);
    expect(reachAwkwardness(0)).toBe(1);
    expect(rushedFrom(1, true)).toBe(0);
    expect(rushedFrom(0, true)).toBe(1);
    expect(rushedFrom(1, false)).toBe(1);
    const spread = (input: ContactInput) => {
      const rng = createRng(9);
      const as = Array.from({ length: 600 }, () => locateContact(input, rng).a);
      const mean = as.reduce((x, y) => x + y, 0) / as.length;
      return Math.sqrt(as.reduce((x, y) => x + (y - mean) ** 2, 0) / as.length);
    };
    const settled = spread(calm);
    expect(spread({ ...calm, rushed: 1 })).toBeGreaterThan(settled * 2);
    expect(spread({ ...calm, lateral: 1.8 })).toBeGreaterThan(settled * 2);
  });

  it('frame hits happen between r 1 and 1.25, and beyond that the racket misses', () => {
    // Late timing with no noise: a = -0.15 - 0.75 u.
    const frame = locateContact({ ...calm, u: 1.3, spin: 0 }, still);
    expect(frame.kind).toBe('frame');
    expect(frame.r).toBeGreaterThan(1);
    expect(frame.r).toBeLessThanOrEqual(CONTACT.frameEdge);
    expect(locateContact({ ...calm, u: 1.55, spin: 0 }, still).kind).toBe('miss');
    expect(locateContact({ ...calm, u: -1.3, spin: 0 }, still).kind).toBe('frame');
    expect(locateContact({ ...calm, u: -1.45, spin: 0 }, still).kind).toBe('miss');
  });
});

describe('contact: what the contact does to the shot', () => {
  it('power transfer falls as 1 - 0.45 d^2 across the bed', () => {
    const c = classify(0.425, 0);
    expect(strikeEffect(c, 1, 0.5, 0.3, still).transfer).toBeCloseTo(1 - 0.45 * 0.25, 9);
  });

  it('the throat is dead and short; the tip twists the ball wide toward the sideline it was heading for', () => {
    const throat = strikeEffect(classify(-0.95, 0), 1, 0.6, 0.3, still);
    const mid = strikeEffect(classify(-0.5, 0), 1, 0.6, 0.3, still);
    expect(throat.transfer).toBeLessThan(mid.transfer - 0.2);
    expect(throat.ddepth).toBeLessThan(-2);
    expect(throat.tilt).toBeLessThan(0);
    const tipRight = strikeEffect(classify(0.9, 0), 1, 0.6, 0.3, still);
    const tipLeft = strikeEffect(classify(0.9, 0), -1, 0.6, 0.3, still);
    expect(tipRight.dx).toBeGreaterThan(0.9);
    expect(tipLeft.dx).toBeLessThan(-0.9);
  });

  it('the top edge launches lower (net risk), the bottom edge higher (long risk)', () => {
    expect(strikeEffect(classify(-0.15, 0.8), 1, 0.6, 0.3, still).tilt).toBeLessThan(0);
    expect(strikeEffect(classify(-0.15, -0.8), 1, 0.6, 0.3, still).tilt).toBeGreaterThan(0);
    expect(strikeEffect(classify(-0.15, 0.3), 1, 0.6, 0.3, still).tilt).toBe(0);
  });

  it('keeps a small length risk for a flat full-power swing, even when centred', () => {
    const rng = createRng(4);
    const c = classify(-0.15, 0);
    const flat = Array.from({ length: 300 }, () => Math.abs(strikeEffect(c, 1, 1, 0, rng).ddepth));
    const topspin = Array.from({ length: 300 }, () => Math.abs(strikeEffect(c, 1, 1, 0.6, rng).ddepth));
    expect(Math.max(...flat)).toBeGreaterThan(1);
    expect(Math.max(...topspin)).toBe(0);
  });

  it('a shank is weak and often into the net', () => {
    const rng = createRng(5);
    const shots = Array.from({ length: 400 }, () => shank(rng, 4.115));
    const net = shots.filter((s) => s.intoNet).length / shots.length;
    expect(net).toBeGreaterThan(0.3);
    expect(net).toBeLessThan(0.5);
    // Slow: long flights, and a slow drift into the net.
    expect(shots.every((s) => s.flight >= 1.5 && s.netFlight >= 0.9)).toBe(true);
  });

  it('tilting a launch keeps its speed and heading', () => {
    const v = { x: 3, y: 4, z: -20 };
    const t = tiltLaunch(v, -0.05);
    expect(Math.hypot(t.x, t.y, t.z)).toBeCloseTo(Math.hypot(v.x, v.y, v.z), 9);
    expect(t.x / t.z).toBeCloseTo(v.x / v.z, 9);
    expect(t.y).toBeLessThan(v.y);
  });
});

describe('contact: serves', () => {
  it('a serve at the top of the toss meets the sweet spot; a late one, low on the face toward the throat', () => {
    const top = locateServeContact(0, 0, 0, still);
    expect(top.a).toBeCloseTo(SWEET_SPOT.a, 6);
    expect(top.quality).toBeCloseTo(1, 6);
    const late = locateServeContact(0.8, 0.9, 0, still);
    expect(late.a).toBeLessThan(-0.6);
    expect(late.b).toBeLessThan(-0.4);
    const early = locateServeContact(-0.5, 0.3, 0, still);
    expect(early.a).toBeGreaterThan(0.2);
  });
});
