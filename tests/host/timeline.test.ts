import { describe, expect, it } from 'vitest';
import { PauseTimeline } from '../../src/host/timeline';

describe('pause timeline', () => {
  it('is the identity with no pauses', () => {
    const t = new PauseTimeline();
    expect(t.toMatchTime(1234)).toBe(1234);
    expect(t.inPause(1234)).toBe(false);
    expect(t.paused).toBe(false);
  });

  it('subtracts only the paused time before t', () => {
    const t = new PauseTimeline();
    t.pause(1000);
    t.resume(1500);
    t.add(3000, 3200); // a long frame gap absorbed
    expect(t.toMatchTime(900)).toBe(900);
    expect(t.toMatchTime(1200)).toBe(1000); // inside the pause: frozen at its start
    expect(t.toMatchTime(2000)).toBe(1500);
    expect(t.toMatchTime(3100)).toBe(2500);
    expect(t.toMatchTime(4000)).toBe(3300);
  });

  it('dates a swing from before a pause with the time it really happened', () => {
    // The old single pausedTotal subtracted a later pause from an earlier swing.
    const t = new PauseTimeline();
    t.pause(1000);
    t.resume(3000);
    expect(t.toMatchTime(990)).toBe(990);
  });

  it('freezes while a pause is open and reports times inside it', () => {
    const t = new PauseTimeline();
    t.pause(1000);
    expect(t.paused).toBe(true);
    expect(t.toMatchTime(5000)).toBe(1000);
    expect(t.inPause(999)).toBe(false);
    expect(t.inPause(1000)).toBe(true);
    expect(t.inPause(5000)).toBe(true);
    t.resume(2000);
    expect(t.inPause(1999)).toBe(true);
    expect(t.inPause(2000)).toBe(false);
  });

  it('ignores a double pause or resume, empty intervals, and resets', () => {
    const t = new PauseTimeline();
    t.pause(100);
    t.pause(200);
    t.resume(300);
    t.resume(400);
    t.add(500, 500);
    t.add(700, 600);
    expect(t.toMatchTime(1000)).toBe(800);
    t.reset();
    expect(t.toMatchTime(1000)).toBe(1000);
  });

  it('does not count an added gap twice when it overlaps an open or recorded pause', () => {
    const t = new PauseTimeline();
    t.pause(1000);
    t.resume(2000);
    t.add(1500, 2500); // overlaps the user pause by 500
    expect(t.toMatchTime(3000)).toBe(1500);
    expect(t.inPause(2400)).toBe(true);
  });
});
