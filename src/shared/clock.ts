export interface ClockSample { rtt: number; offset: number }

export class ClockEstimator {
  private samples: ClockSample[] = [];

  add(h: number, p: number, now: number): ClockSample | undefined {
    const rtt = now - h;
    if (![h, p, now].every(Number.isFinite) || rtt < 0) return this.best;
    this.samples.push({ rtt, offset: p - (h + rtt / 2) });
    if (this.samples.length > 10) this.samples.shift();
    return this.best;
  }

  get best(): ClockSample | undefined {
    return this.samples.reduce<ClockSample | undefined>(
      (best, sample) => !best || sample.rtt < best.rtt ? sample : best, undefined,
    );
  }

  toHost(phoneTime: number): number {
    return phoneTime - (this.best?.offset ?? 0);
  }
}
