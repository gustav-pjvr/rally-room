import { describe, expect, it, vi } from 'vitest';
import { DRILL_POINTS, createDrill, practiceStations, tutorialStations, type Station } from '../../src/engine/drill';
import { createRng } from '../../src/engine/rng';
import type { DrillView, MatchEvent } from '../../src/engine/types';
import { runMatch, type Bot } from '../../src/sim/runner';

// Whole simulated matches: quick on a free machine, slow when the laptop is busy with other work.
vi.setConfig({ testTimeout: 120_000 });

/** Drills (docs/v2/PLAN.md M1): practice at targets and the tutorial, on the match engine. */

type DrillEvent = Extract<MatchEvent, { type: 'drill' }>;
const drillEvents = (events: { e: MatchEvent }[]) => events.map((x) => x.e).filter((e): e is DrillEvent => e.type === 'drill');
const feed = (extra: Partial<Station>): Station => ({ title: 'T', hint: 'h', kind: 'feed', feed: 'forehand', goal: 'in', need: 2, ...extra });
/** Swings `dt` ms from the ideal contact (a function of the drill view, so a bot can follow the lit target). */
const bot = (dt: (drill: DrillView) => number, power = 0.6, spin = 0.3): Bot => ({
  swing: (ctx) => ({ dt: ctx.kind === 'serve' ? 0 : dt(ctx.view.drill!), power, spin }),
});

describe('drill stations', () => {
  it('counts balls that land in, and ends when every station is done', () => {
    const d = createDrill({ kind: 'tutorial', stations: [feed({ need: 3 })], window: 'normal', seed: 1 });
    const r = runMatch(d, { 0: bot(() => 0) });
    expect(r.timedOut).toBe(false);
    const ev = drillEvents(r.events);
    expect(ev.filter((e) => e.result === 'in' || e.result === 'target').length).toBe(3);
    expect(ev[ev.length - 1]).toMatchObject({ stationDone: true, finished: true });
    expect(r.view.winner).toBe('near');
    expect(r.events.some((x) => x.e.type === 'match')).toBe(true);
  });

  it('does not count a ball the player lets go, and feeds again', () => {
    const d = createDrill({ kind: 'tutorial', stations: [feed({ need: 1 })], window: 'normal', seed: 1 });
    let balls = 0;
    const r = runMatch(d, { 0: { swing: () => (balls++ < 2 ? null : { dt: 0, power: 0.6, spin: 0.3 }) } });
    const ev = drillEvents(r.events);
    expect(ev.map((e) => e.result)).toEqual(['missed', 'missed', 'in']);
    expect(r.view.drill!.bestStreak).toBe(1);
  });

  it('teaches timing is aim: early swings land in the cross-court half, late ones down the line', () => {
    const early = createDrill({ kind: 'tutorial', stations: [feed({ targets: 'cross', goal: 'target', need: 4 })], window: 'normal', seed: 2 });
    const re = runMatch(early, { 0: bot(() => -90) });
    expect(re.timedOut).toBe(false);
    const late = createDrill({ kind: 'tutorial', stations: [feed({ targets: 'line', goal: 'target', need: 4 })], window: 'normal', seed: 2 });
    const rl = runMatch(late, { 0: bot(() => 90) });
    expect(rl.timedOut).toBe(false);
    // The wrong timing never passes the station: a late swing cannot reach the cross-court half.
    const wrong = createDrill({ kind: 'tutorial', stations: [feed({ targets: 'cross', goal: 'target', need: 2 })], window: 'normal', seed: 2 });
    const rw = runMatch(wrong, { 0: bot(() => 90) }, { maxMs: 120_000 });
    expect(rw.timedOut).toBe(true);
    expect(drillEvents(rw.events).every((e) => e.result !== 'target')).toBe(true);
  });

  it('puts the lit half on the opposite side for a backhand feed and for a left-hander', () => {
    const lit = (leftHanded: boolean, side: 'forehand' | 'backhand') => {
      const d = createDrill({
        kind: 'tutorial', stations: [feed({ feed: side, targets: 'cross', goal: 'target' })], window: 'normal', seed: 1, leftHanded,
      });
      d.update(1000);
      return Math.sign(d.view().drill!.targets[0].x);
    };
    // A right-hander's forehand feed goes to +x, so cross-court is -x.
    expect(lit(false, 'forehand')).toBe(-1);
    expect(lit(false, 'backhand')).toBe(1);
    expect(lit(true, 'forehand')).toBe(1);
  });

  it('asks for serves at a serve station and only counts serves in the box', () => {
    const d = createDrill({
      kind: 'tutorial', stations: [{ title: 'Serve', hint: 'h', kind: 'serve', goal: 'serve-in', need: 2 }], window: 'normal', seed: 3,
    });
    const r = runMatch(d, { 0: bot(() => 0, 0.5, 0.3) });
    expect(r.timedOut).toBe(false);
    const ev = drillEvents(r.events);
    expect(ev.filter((e) => e.result === 'in').length).toBe(2);
    expect(ev.every((e) => e.result === 'in' || e.result === 'fault')).toBe(true);
    expect(r.events.filter((x) => x.e.type === 'toss').length).toBeGreaterThanOrEqual(2);
  });

  it('passes the spin stations only with the right spin', () => {
    const topspin = (spin: number) => {
      const d = createDrill({ kind: 'tutorial', stations: [feed({ goal: 'topspin', need: 1 })], window: 'normal', seed: 4 });
      return runMatch(d, { 0: bot(() => 0, 0.6, spin) }, { maxMs: 60_000 }).timedOut;
    };
    expect(topspin(0.6)).toBe(false);
    expect(topspin(0)).toBe(true);
  });

  it('skips a station on request', () => {
    const d = createDrill({ kind: 'tutorial', stations: [feed({ need: 99 }), feed({ title: 'Second', need: 1 })], window: 'normal', seed: 1 });
    d.update(1000);
    expect(d.view().drill!.station).toBe(0);
    d.skip!();
    expect(d.view().drill).toMatchObject({ station: 1, title: 'Second', done: 0 });
    d.skip!();
    expect(d.view().phase).toBe('match-over');
  });
});

describe('the tutorial', () => {
  it('can be passed from start to finish by a player who follows each hint', () => {
    const d = createDrill({ kind: 'tutorial', stations: tutorialStations(), window: 'easy', seed: 5 });
    const follow: Bot = {
      swing: (ctx) => {
        const drill = ctx.view.drill!;
        if (ctx.kind === 'serve') return { dt: 0, power: 0.5, spin: 0.3 };
        const dt = drill.title === 'Swing early' ? -120 : drill.title === 'Swing late' ? 120 : 0;
        return { dt, power: 0.6, spin: drill.title === 'Topspin' ? 0.7 : 0.3 };
      },
    };
    const r = runMatch(d, { 0: follow }, { maxMs: 10 * 60_000 });
    expect(r.timedOut).toBe(false);
    expect(drillEvents(r.events).filter((e) => e.stationDone).length).toBe(tutorialStations().length);
    expect(r.view.message).toBe('Ready to play');
    // Short enough to finish before a new player loses interest: under four minutes when every ball counts.
    expect(r.ms).toBeLessThan(4 * 60_000);
  });
});

describe('target practice', () => {
  it('feeds a basket, lights one zone per ball and scores targets above plain balls in', () => {
    const d = createDrill({ kind: 'practice', stations: practiceStations('club', 12), window: 'normal', seed: 6 });
    const rng = createRng(9);
    // Aim at the lit zone: early for cross-court, late for down the line, on time for the middle.
    const aim: Bot = bot((drill) => {
      const litZone = drill.targets.find((t) => t.lit)!;
      const base = litZone.label === 'Cross-court' ? -85 : litZone.label === 'Down the line' ? 85 : 0;
      return base + (rng() * 2 - 1) * 15;
    }, 0.65, 0.4);
    const r = runMatch(d, { 0: aim });
    expect(r.timedOut).toBe(false);
    const ev = drillEvents(r.events);
    expect(ev.length).toBe(12);
    const targets = ev.filter((e) => e.result === 'target').length;
    const plain = ev.filter((e) => e.result === 'in').length;
    expect(r.view.drill!.score).toBe(targets * DRILL_POINTS.target + plain * DRILL_POINTS.in);
    expect(targets).toBeGreaterThanOrEqual(5);
    // A player who ignores the zones and always swings on time scores clearly less.
    const lazy = createDrill({ kind: 'practice', stations: practiceStations('club', 12), window: 'normal', seed: 6 });
    const rl = runMatch(lazy, { 0: bot(() => 0, 0.65, 0.4) });
    expect(rl.view.drill!.score).toBeLessThan(r.view.drill!.score);
  });

  it('shows three zones with exactly one lit, inside the far court', () => {
    const d = createDrill({ kind: 'practice', stations: practiceStations('pro'), window: 'normal', seed: 1 });
    d.update(1000);
    const zones = d.view().drill!.targets;
    expect(zones.length).toBe(3);
    expect(zones.filter((z) => z.lit).length).toBe(1);
    for (const z of zones) {
      expect(z.z + z.d / 2).toBeLessThan(0);
      expect(Math.abs(z.x) + z.w / 2).toBeLessThanOrEqual(4.115);
    }
  });
});
