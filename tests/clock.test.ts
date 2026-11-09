import { describe, expect, it } from 'vitest';
import { ClockEstimator } from '../src/shared/clock';

describe('clock estimator', () => {
  it('keeps the offset of the lowest-rtt sample', () => {
    const c = new ClockEstimator();
    // The phone clock runs 500 ms ahead of the host. Latencies vary.
    c.add(0, 40 + 500, 80); // rtt 80
    c.add(1000, 1005 + 500, 1010); // rtt 10
    c.add(2000, 2060 + 500, 2100); // rtt 100
    expect(c.best?.rtt).toBe(10);
    expect(c.best?.offset).toBeCloseTo(500, 5);
    expect(c.toHost(10_500)).toBeCloseTo(10_000, 5);
  });

  it('forgets samples older than the last 10 and ignores bad input', () => {
    const c = new ClockEstimator();
    c.add(0, 500, 2); // rtt 2, offset 499
    for (let i = 1; i <= 10; i++) c.add(i * 100, i * 100 + 20 + 300, i * 100 + 40);
    expect(c.best?.offset).toBeCloseTo(300, 5);
    c.add(5000, NaN, 5001);
    c.add(6000, 6300, 5990); // negative rtt
    expect(c.best?.offset).toBeCloseTo(300, 5);
  });
});
