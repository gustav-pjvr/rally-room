/**
 * Match time from host time (DESIGN.md section 3, clock sync). Every pause is
 * recorded as an interval of host time: the user's pause, a pause for a
 * missing phone, a hidden tab, and the part of a long frame gap that is
 * absorbed. toMatchTime(t) subtracts only the paused time before t, so a
 * swing that happened before a pause keeps its real match time. Pure, no DOM:
 * unit tested in tests/host/timeline.test.ts.
 */
export class PauseTimeline {
  /** Closed intervals [start, end), sorted and not overlapping. */
  private intervals: [number, number][] = [];
  private openAt: number | null = null;

  get paused(): boolean { return this.openAt !== null; }

  /** Host time the open pause began, or null. */
  get pausedAt(): number | null { return this.openAt; }

  pause(t: number): void {
    if (this.openAt === null) this.openAt = t;
  }

  resume(t: number): void {
    if (this.openAt === null) return;
    const start = this.openAt;
    this.openAt = null;
    this.add(start, t);
  }

  /** Records [start, end) as paused (a long frame gap). Overlaps with earlier pauses count once. */
  add(start: number, end: number): void {
    if (!(end > start)) return;
    const merged: [number, number][] = [];
    let s = start, e = end;
    for (const [a, b] of this.intervals) {
      if (b < s || a > e) merged.push([a, b]);
      else { s = Math.min(s, a); e = Math.max(e, b); }
    }
    merged.push([s, e]);
    merged.sort((x, y) => x[0] - y[0]);
    this.intervals = merged;
  }

  /** Host time minus the paused time before it. Inside a pause it stays at the pause's start. */
  toMatchTime(t: number): number {
    let paused = 0;
    for (const [a, b] of this.intervals) {
      if (a >= t) break;
      paused += Math.min(b, t) - a;
    }
    if (this.openAt !== null && t > this.openAt) {
      // Do not count again the part of the open pause that a recorded interval already covers.
      let open = t - this.openAt;
      for (const [a, b] of this.intervals) {
        const overlap = Math.min(b, t) - Math.max(a, this.openAt);
        if (overlap > 0) open -= overlap;
      }
      paused += Math.max(0, open);
    }
    return t - paused;
  }

  /** True when host time t falls inside a pause: a swing then is dropped. */
  inPause(t: number): boolean {
    if (this.openAt !== null && t >= this.openAt) return true;
    return this.intervals.some(([a, b]) => t >= a && t < b);
  }

  reset(): void {
    this.intervals = [];
    this.openAt = null;
  }
}
