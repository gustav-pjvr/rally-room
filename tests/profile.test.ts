import { describe, expect, it } from 'vitest';
import { AxisCalibrator, RacketAxisLearner, SaturationWatch, applyMap, mapKey } from '../src/shared/profile';
import { SwingDetector, type Vector } from '../src/shared/swing';
import { asPhone, loadLabelled, play, type FakePhone } from './fixtures/phones';

// Gustav's labelled Samsung A32 recording, replayed as if made on phones that
// report motion differently. Each must set itself up from normal swinging.
const rec = loadLabelled();
const a32 = play(asPhone(rec, { name: 'A32' }));

function lockTime(phone: FakePhone) {
  const c = new AxisCalibrator();
  for (const s of asPhone(rec, phone)) {
    c.add({ t: s.t, accel: s.accel, native: s.native! });
    if (c.best) return { seconds: (s.t - rec[0].t) / 1000, map: c.best };
  }
  return null;
}

describe('automatic phone setup', () => {
  const phones: [FakePhone, string][] = [
    [{ name: 'A32 as recorded' }, '012+++deg'],
    [{ name: 'axes scrambled and flipped', perm: [2, 0, 1], sign: [-1, 1, -1] }, '120+--deg'],
    [{ name: 'reports rad/s', radians: true }, '012+++rad'],
    [{ name: 'everything different', perm: [1, 2, 0], sign: [1, -1, -1], radians: true, flipAccel: true }, '201-+-rad'],
  ];

  for (const [phone, expected] of phones) {
    it(`${phone.name}: learns its axes within 90 s of play and reads swings like the A32`, () => {
      const lock = lockTime(phone);
      expect(lock && mapKey(lock.map)).toBe(expected);
      expect(lock!.seconds).toBeLessThan(90);
      const r = play(asPhone(rec, phone));
      expect(Math.abs(r.swings.length - a32.swings.length)).toBeLessThanOrEqual(2);
      expect(r.spinAccuracy).toBeGreaterThanOrEqual(0.75);
    });
  }

  it('learned mapping undoes the scramble exactly', () => {
    const scramble: FakePhone = { name: 'x', perm: [2, 0, 1], sign: [-1, 1, -1] };
    const map = lockTime(scramble)!.map;
    const truth: Vector = [100, -200, 300];
    const reported = asPhone([{ t: 0, accel: [0, 0, 9.81], native: truth, label: '' }], scramble)[0].native!;
    expect(applyMap(map, reported)).toEqual(truth);
  });

  it('a flipped accelerometer gives the same spin, because the racket axis is learned', () => {
    const r = play(asPhone(rec, { name: 'flip', flipAccel: true }));
    expect(r.spinAccuracy).toBeCloseTo(a32.spinAccuracy, 5);
    expect(r.report.racket[1]).toBeLessThan(-0.7); // learned axis points the other way
  });

  it('a gyro that tops out early is noticed and still finds the swings', () => {
    const r = play(asPhone(rec, { name: 'cap', gyroCap: 500 }));
    expect(r.report.gyroCap).toBe(500);
    expect(r.swings.length).toBeGreaterThanOrEqual(a32.swings.length * 0.9);
    expect(r.swings.length).toBeLessThanOrEqual(a32.swings.length * 1.3);
  });

  it('a phone with no gyro falls back to the accelerometer', () => {
    const r = play(asPhone(rec, { name: 'none', noGyro: true }));
    expect(r.report.mode).toBe('accel');
    expect(r.swings.length).toBeGreaterThanOrEqual(a32.swings.length * 0.9);
    expect(r.swings.length).toBeLessThanOrEqual(a32.swings.length * 1.2);
    expect(r.swings.every((s) => s.spin === 0)).toBe(true);
  });

  it('remembers what it learned, so the next game starts set up', () => {
    let saved: ReturnType<SwingDetector['save']> | undefined;
    const d = new SwingDetector(undefined, (p) => { saved = p; });
    for (const s of asPhone(rec, { name: 'rad', radians: true })) d.sample(s.t, s.accel, s.native);
    expect(saved?.map && mapKey(saved.map)).toBe('012+++rad');
    const next = new SwingDetector(JSON.parse(JSON.stringify(saved)));
    expect(mapKey(next.map)).toBe('012+++rad');
    expect(next.report().racketSwings).toBeGreaterThanOrEqual(RacketAxisLearner.MIN_SWINGS);
  });
});

describe('profile parts', () => {
  it('saturation needs three swings at the same top', () => {
    const w = new SaturationWatch();
    w.add([500, 10, 10]); w.add([300, 499.9, 0]);
    expect(w.cap).toBeNull();
    w.add([-500, 0, 0]);
    expect(w.cap).toBe(500);
  });
});
