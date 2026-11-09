import { describe, expect, it } from 'vitest';
import {
  HIT_WINDOW_MS, MISS_GRACE_MS, TOSS, createMatch, type GameMatch, type MatchOptions,
} from '../../src/host/game/match';
import { type MatchConfig, type MatchEvent } from '../../src/host/game/types';

/** Regression tests for the four findings of the independent review of the rules engine. */

const FRAME = 1000 / 60;
const BASE: MatchConfig = { mode: 'singles', humans: 1, level: 'rookie', window: 'normal', length: 'set1', seed: 1 };
const W = HIT_WINDOW_MS.normal;

interface Sim {
  m: GameMatch;
  now: number;
  log: { now: number; e: MatchEvent }[];
  step(to?: number): MatchEvent[];
  until(done: () => boolean, max?: number): void;
}

/** A match driven at 60 fps; collects every event with the time it was reported. */
function sim(config: Partial<MatchConfig> = {}, options: MatchOptions = {}): Sim {
  const m: GameMatch = createMatch({ ...BASE, ...config }, options);
  const log: { now: number; e: MatchEvent }[] = [];
  const s: Sim = {
    m,
    now: 1000,
    log,
    step(to = s.now + FRAME): MatchEvent[] {
      s.now = to;
      const events = m.update(to);
      for (const e of events) log.push({ now: to, e });
      return events;
    },
    until(done: () => boolean, max = 20_000) {
      for (let i = 0; i < max; i++) {
        if (done()) return;
        s.step();
      }
      throw new Error('condition not reached');
    },
  };
  m.update(s.now);
  return s;
}

/** Step frames up to time t, then land exactly on t. */
function stepExact(s: Sim, t: number): MatchEvent[] {
  while (s.now + FRAME < t) s.step();
  return s.step(t);
}

describe('review fix 1: no strike before the first bounce', () => {
  it('a swing at the very start of the window never hits a ball that has not bounced yet', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const s = sim({ seed });
      let lastSeen: number | null = null;
      for (let frame = 0; frame < 60 * 60 * 3 && s.m.view().phase !== 'match-over'; frame++) {
        s.step();
        const v = s.m.view();
        if (v.phase === 'serve-wait' && v.serverIndex === 0 && v.message === null) {
          s.m.swing({ player: 0, t: s.now, power: 0.5, spin: 0.2 });
          continue;
        }
        const tStar = s.m.expectedContact(0);
        if (tStar === null || tStar === lastSeen || v.phase !== 'rally') continue;
        lastSeen = tStar;
        // The earliest moment the window accepts a swing (plus 0.5 ms, clear of float noise at the edge).
        const earliest = tStar - W + 0.5;
        if (earliest <= s.now) continue;
        stepExact(s, earliest);
        const bounced = s.m.view().ball.bounces >= 1;
        s.m.swing({ player: 0, t: earliest, power: 0.5, spin: 0 });
        const events = s.step(s.now);
        if (!bounced) {
          expect(events.some((e) => e.type === 'hit'), `seed ${seed}: hit before the first bounce`).toBe(false);
        }
        // Carry on with a perfect return so the rally continues.
        if (s.m.expectedContact(0) === tStar) {
          stepExact(s, tStar);
          s.m.swing({ player: 0, t: tStar, power: 0.6, spin: 0.2 });
        }
      }
    }
  });

  it('plans human contact at least W after the first bounce', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const s = sim({ seed });
      let lastSeen: number | null = null;
      for (let frame = 0; frame < 60 * 60 * 2 && s.m.view().phase !== 'match-over'; frame++) {
        s.step();
        const v = s.m.view();
        if (v.phase === 'serve-wait' && v.serverIndex === 0 && v.message === null) {
          s.m.swing({ player: 0, t: s.now, power: 0.5, spin: 0.2 });
          continue;
        }
        const tStar = s.m.expectedContact(0);
        if (tStar === null || tStar === lastSeen || v.phase !== 'rally') continue;
        lastSeen = tStar;
        // The ball has bounced by T* - W: stepping to that time must show the bounce.
        if (tStar - W <= s.now) continue;
        stepExact(s, tStar - W + 0.5);
        expect(s.m.view().ball.bounces, `seed ${seed}`).toBeGreaterThanOrEqual(1);
        if (s.m.expectedContact(0) === tStar) {
          stepExact(s, tStar);
          s.m.swing({ player: 0, t: tStar, power: 0.6, spin: 0.2 });
        }
      }
    }
  });
});

describe('review fix 2: a stronger serve swing replaces the first', () => {
  function tossed() {
    const s = sim({}, { firstServer: 'near' });
    s.m.swing({ player: 0, t: s.now, power: 0.3, spin: 0 });
    const tossAt = s.now;
    s.step();
    expect(s.m.view().phase).toBe('toss');
    return { s, tossAt };
  }

  it('power 0.2 at toss + 300 ms serves, and power 1.0 at the top of the toss replaces it', () => {
    const { s, tossAt } = tossed();
    const apex = s.m.expectedContact(0)!;
    stepExact(s, tossAt + 300);
    s.m.swing({ player: 0, t: tossAt + 300, power: 0.2, spin: 0 });
    const weak = s.step(s.now).find((e) => e.type === 'hit');
    expect(weak).toBeDefined();
    expect(weak!.type === 'hit' && weak!.power).toBeCloseTo(0.2, 9);
    expect(s.m.view().phase).toBe('rally');
    stepExact(s, apex);
    s.m.swing({ player: 0, t: apex, power: 1, spin: 0 });
    const strong = s.step(s.now).find((e) => e.type === 'hit');
    expect(strong).toBeDefined();
    expect(strong!.type === 'hit' && strong!.power).toBeCloseTo(1, 9);
    expect(strong!.type === 'hit' && strong!.u).toBeCloseTo(0, 6);
    expect(s.m.view().phase).toBe('rally');
    expect(s.m.view().rally).toBe(1);
    // The replacement is launched from the toss ball's position at the swing's time (about 3 m up).
    expect(s.m.view().ball.pos.y).toBeGreaterThan(2.9);
  });

  it('a weaker or equal later swing does not replace the serve', () => {
    const { s, tossAt } = tossed();
    const apex = s.m.expectedContact(0)!;
    stepExact(s, apex);
    s.m.swing({ player: 0, t: apex, power: 0.8, spin: 0 });
    expect(s.step(s.now).some((e) => e.type === 'hit')).toBe(true);
    stepExact(s, apex + 100);
    s.m.swing({ player: 0, t: apex + 100, power: 0.8, spin: 0 });
    s.m.swing({ player: 0, t: apex + 100, power: 0.3, spin: 0 });
    expect(s.step(s.now).some((e) => e.type === 'hit')).toBe(false);
    expect(tossAt).toBeLessThan(apex);
  });

  it('a stronger swing outside the toss window does not replace the serve', () => {
    const { s, tossAt } = tossed();
    const apex = s.m.expectedContact(0)!;
    stepExact(s, apex);
    s.m.swing({ player: 0, t: apex, power: 0.2, spin: 0 });
    expect(s.step(s.now).some((e) => e.type === 'hit')).toBe(true);
    stepExact(s, tossAt + TOSS.hitUntilMs + 100);
    s.m.swing({ player: 0, t: tossAt + TOSS.hitUntilMs + 100, power: 1, spin: 0 });
    expect(s.step(s.now).some((e) => e.type === 'hit')).toBe(false);
  });
});

describe('review fix 3: lag allowance and backdated tosses', () => {
  it('MISS_GRACE_MS is 300 ms, the contract lag', () => {
    expect(MISS_GRACE_MS).toBe(300);
  });

  it('a swing dated at the end of the window and reported 299 ms late still hits', () => {
    const s = sim();
    s.until(() => s.m.expectedContact(0) !== null && s.m.view().phase === 'rally' && s.m.view().ball.bounces >= 1);
    const tStar = s.m.expectedContact(0)!;
    const swingT = tStar + W - 1;
    stepExact(s, swingT + 299);
    s.m.swing({ player: 0, t: swingT, power: 0.5, spin: 0 });
    const events = s.step(s.now);
    expect(events.some((e) => e.type === 'hit' && e.player === 0)).toBe(true);
    expect(s.log.some((x) => x.e.type === 'point')).toBe(false);
  });

  it('a swing made during the fault pause cannot start a backdated toss', () => {
    const s = sim({}, { firstServer: 'near' });
    s.m.swing({ player: 0, t: s.now, power: 0.3, spin: 0 });
    const tossAt = s.now;
    s.step();
    stepExact(s, tossAt + 1100);
    s.m.swing({ player: 0, t: tossAt + 1100, power: 0.8, spin: 0 });
    s.until(() => s.log.some((x) => x.e.type === 'fault'), 200);
    s.until(() => s.m.view().phase === 'serve-wait' && s.m.view().message === null, 400);
    const before = s.log.length;
    s.m.swing({ player: 0, t: s.now - 500, power: 0.3, spin: 0 });
    s.step();
    expect(s.log.slice(before).some((x) => x.e.type === 'toss')).toBe(false);
    expect(s.m.view().phase).toBe('serve-wait');
    // A swing dated after the serve became ready still tosses.
    s.m.swing({ player: 0, t: s.now, power: 0.3, spin: 0 });
    expect(s.step().some((e) => e.type === 'toss')).toBe(true);
  });

  it('a late swing dated inside an expired toss cannot start a backdated toss', () => {
    const s = sim({}, { firstServer: 'near' });
    s.m.swing({ player: 0, t: s.now, power: 0.3, spin: 0 });
    const tossAt = s.now;
    s.step();
    s.until(() => s.m.view().phase === 'serve-wait', 200);
    const before = s.log.length;
    s.m.swing({ player: 0, t: tossAt + 500, power: 0.3, spin: 0 });
    s.step();
    expect(s.log.slice(before).some((x) => x.e.type === 'toss')).toBe(false);
  });
});

describe('review fix 4: swings must be finite numbers', () => {
  it('ignores NaN or infinite t, power or spin', () => {
    const bad = [
      { t: NaN, power: 0.5, spin: 0 }, { t: Infinity, power: 0.5, spin: 0 },
      { t: 0, power: NaN, spin: 0 }, { t: 0, power: Infinity, spin: 0 },
      { t: 0, power: 0.5, spin: NaN }, { t: 0, power: 0.5, spin: -Infinity },
    ];
    for (const b of bad) {
      const s = sim({}, { firstServer: 'near' });
      s.step();
      s.m.swing({ player: 0, t: Number.isFinite(b.t) ? s.now : b.t, power: b.power, spin: b.spin });
      expect(s.step().some((e) => e.type === 'toss'), JSON.stringify(b)).toBe(false);
      expect(s.m.view().phase).toBe('serve-wait');
    }
  });
});
