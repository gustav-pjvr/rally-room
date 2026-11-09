import { describe, expect, it } from 'vitest';
import {
  HIT_WINDOW_MS, MISS_GRACE_MS, TOSS, createMatch, type GameMatch, type MatchOptions,
} from '../../src/host/game/match';
import { COURT, type MatchConfig, type MatchEvent } from '../../src/host/game/types';

const FRAME = 1000 / 60;
const BASE: MatchConfig = { mode: 'singles', humans: 1, level: 'rookie', window: 'normal', length: 'set1', seed: 1 };

interface Sim {
  m: GameMatch;
  now: number;
  log: { now: number; e: MatchEvent }[];
  step(to?: number): MatchEvent[];
  until(done: () => boolean, max?: number): void;
  untilEvent<T extends MatchEvent['type']>(type: T, max?: number): Extract<MatchEvent, { type: T }>;
}

/** A match driven at 60 fps; collects every event with the time it was reported. */
function sim(config: Partial<MatchConfig> = {}, options: MatchOptions = {}): Sim {
  const m: GameMatch = createMatch({ ...BASE, ...config }, options);
  const log: { now: number; e: MatchEvent }[] = [];
  const s: Sim = {
    m,
    now: 1000,
    log,
    /** Advance to an exact time (default: one frame). */
    step(to = s.now + FRAME): MatchEvent[] {
      s.now = to;
      const events = m.update(to);
      for (const e of events) log.push({ now: to, e });
      return events;
    },
    /** Step frames until `done` is true; fails after `max` frames. */
    until(done: () => boolean, max = 20_000) {
      for (let i = 0; i < max; i++) {
        if (done()) return;
        s.step();
      }
      throw new Error('condition not reached');
    },
    /** Step until an event of this type is reported; returns it. */
    untilEvent<T extends MatchEvent['type']>(type: T, max = 20_000): Extract<MatchEvent, { type: T }> {
      for (let i = 0; i < max; i++) {
        const found = s.step().find((e) => e.type === type);
        if (found) return found as Extract<MatchEvent, { type: T }>;
      }
      throw new Error(`no ${type} event`);
    },
  };
  m.update(s.now);
  return s;
}

/** Run until a ball that has bounced in is coming to the human; returns T*. */
function toIncoming(s: Sim, player = 0): number {
  s.until(() => s.m.expectedContact(player) !== null && s.m.view().phase === 'rally' && s.m.view().ball.bounces >= 1);
  return s.m.expectedContact(player)!;
}

/** Return the serve perfectly, then run until the CPU's rally ball is coming (retrying if the CPU errs). */
function toRallyIncoming(s: Sim): number {
  for (let tries = 0; tries < 20; tries++) {
    const serve = toIncoming(s);
    stepTo(s, serve);
    s.m.swing({ player: 0, t: serve, power: 0.5, spin: 0.3 });
    const points = s.log.filter((x) => x.e.type === 'point').length;
    const tStar = toIncoming(s);
    if (s.log.filter((x) => x.e.type === 'point').length === points && s.m.view().rally >= 3) return tStar;
  }
  throw new Error('no rally ball');
}

/** Step to the frame at or just after time t. */
function stepTo(s: Sim, t: number) {
  while (s.now < t) s.step();
}

const W = HIT_WINDOW_MS.normal;

describe('match: hitting', () => {
  it('a perfectly timed swing returns the ball into the far court', () => {
    const s = sim();
    const tStar = toIncoming(s);
    stepTo(s, tStar);
    s.m.swing({ player: 0, t: tStar, power: 0.6, spin: 0.3 });
    const hit = s.untilEvent('hit');
    expect(hit.player).toBe(0);
    expect(hit.u).toBeCloseTo(0, 9);
    expect(hit.quality).toBeCloseTo(1, 9);
    expect(hit.speedKmh).toBeGreaterThan(30);
    expect(s.m.view().rally).toBe(2);
    const landing = s.m.view().ball.landing!;
    expect(landing.z).toBeLessThan(0);
    const bounce = s.untilEvent('bounce');
    expect(bounce.in).toBe(true);
    expect(bounce.pos.z).toBeLessThan(0);
    expect(bounce.pos.z).toBeCloseTo(landing.z, 6);
    // Perfect timing aims at the middle: target x = hitSide * 0 * ...
    expect(Math.abs(bounce.pos.x)).toBeLessThan(1e-6);
  });

  it('an early swing goes cross-court and a late one down the line', () => {
    for (const u of [-0.6, 0.6]) {
      const s = sim({ seed: 3 });
      const tStar = toIncoming(s);
      const ts = tStar + u * W;
      while (s.now + FRAME < ts) s.step();
      s.step(ts);
      const contactX = s.m.view().ball.pos.x;
      const hitSide = Math.abs(contactX) < 0.05 ? 1 : Math.sign(contactX);
      s.m.swing({ player: 0, t: ts, power: 0.6, spin: 0.2 });
      const hit = s.untilEvent('hit');
      expect(hit.u).toBeCloseTo(u, 6);
      expect(hit.quality).toBeCloseTo(0.4, 6);
      const bounce = s.untilEvent('bounce');
      expect(bounce.in).toBe(true);
      // Early (u < 0): the opposite side to the contact. Late: the same side.
      expect(Math.sign(bounce.pos.x)).toBe(u < 0 ? -hitSide : hitSide);
      expect(Math.abs(bounce.pos.x)).toBeCloseTo(0.6 * 0.75 * COURT.singlesHalfWidth, 6);
    }
  });

  it('ignores a swing 300 ms early (no whiff), and the real swing still hits', () => {
    const s = sim();
    const tStar = toIncoming(s);
    stepTo(s, tStar - 300);
    s.m.swing({ player: 0, t: tStar - 300, power: 1, spin: 0 });
    const events = s.step();
    expect(events.some((e) => e.type === 'whiff' || e.type === 'hit')).toBe(false);
    stepTo(s, tStar);
    s.m.swing({ player: 0, t: tStar, power: 0.5, spin: 0 });
    const hit = s.untilEvent('hit');
    expect(hit.player).toBe(0);
    expect(s.log.some((x) => x.e.type === 'whiff')).toBe(false);
  });

  it('with no swing the point is lost only after T* + W + 300 ms', () => {
    const s = sim();
    const tStar = toRallyIncoming(s);
    const before = s.log.length;
    const point = s.untilEvent('point');
    expect(point).toEqual({ type: 'point', winner: 'far', reason: 'missed' });
    const when = s.log.slice(before).find((x) => x.e.type === 'point')!.now;
    expect(when).toBeGreaterThanOrEqual(tStar + W + MISS_GRACE_MS);
    expect(when).toBeLessThan(tStar + W + MISS_GRACE_MS + FRAME + 1e-6);
    expect(s.m.view().phase).toBe('point-over');
    expect(s.m.view().message).toBe('Missed');
  });

  it('an unreturned serve is an ace', () => {
    const s = sim();
    toIncoming(s);
    expect(s.untilEvent('point')).toEqual({ type: 'point', winner: 'far', reason: 'ace' });
    expect(s.m.view().score.points).toEqual(['0', '15']);
  });

  it('lag compensation: a swing reported 150 ms late still hits from where the ball was', () => {
    const s = sim();
    const tStar = toIncoming(s);
    stepTo(s, tStar + 150);
    s.m.swing({ player: 0, t: tStar, power: 0.6, spin: 0.3 });
    const hit = s.untilEvent('hit');
    expect(hit.quality).toBeCloseTo(1, 9);
    expect(s.m.view().ball.vel.z).toBeLessThan(0);
    const bounce = s.untilEvent('bounce');
    expect(bounce.in).toBe(true);
    expect(bounce.pos.z).toBeLessThan(0);
  });

  it('the strongest swing inside the window counts', () => {
    const s = sim();
    const tStar = toIncoming(s);
    stepTo(s, tStar - 60);
    s.m.swing({ player: 0, t: tStar - 60, power: 0.2, spin: 0 });
    const weak = s.untilEvent('hit');
    expect(weak.power).toBeCloseTo(0.2, 9);
    stepTo(s, tStar + 40);
    s.m.swing({ player: 0, t: tStar + 40, power: 0.8, spin: 0 });
    const strong = s.untilEvent('hit', 2);
    expect(strong.power).toBeCloseTo(0.8, 9);
    expect(s.m.view().rally).toBe(2);
  });

  it('the hit window depends on the setting: 100 ms late is in for easy, out for pro', () => {
    for (const [window, hits] of [['easy', true], ['pro', false]] as const) {
      const s = sim({ window });
      const tStar = toIncoming(s);
      stepTo(s, tStar + 100);
      s.m.swing({ player: 0, t: tStar + 100, power: 0.5, spin: 0 });
      const events = s.step();
      expect(events.some((e) => e.type === 'hit')).toBe(hits);
    }
  });
});

describe('match: serving', () => {
  it('first swing tosses (up to about 3 m, back down in 1.1 s), second swing at the top serves', () => {
    const s = sim({}, { firstServer: 'near' });
    expect(s.m.view().phase).toBe('serve-wait');
    expect(s.m.view().serverIndex).toBe(0);
    expect(s.m.view().players[0].stance).toBe('serve');
    s.m.swing({ player: 0, t: s.now, power: 0.3, spin: 0 });
    const tossAt = s.now;
    expect(s.step()).toContainEqual({ type: 'toss', player: 0 });
    expect(s.m.view().phase).toBe('toss');
    const apex = s.m.expectedContact(0)!;
    s.step(apex);
    expect(s.m.view().ball.pos.y).toBeCloseTo(3, 1);
    const releaseY = TOSS.releaseY;
    s.m.swing({ player: 0, t: apex, power: 0.7, spin: 0.3 });
    const hit = s.untilEvent('hit', 1);
    expect(hit.quality).toBeCloseTo(1, 6);
    expect(s.m.view().phase).toBe('rally');
    // Near server, deuce court: the ball goes to the far deuce box (x < 0).
    const bounce = s.untilEvent('bounce');
    expect(bounce.in).toBe(true);
    expect(bounce.pos.x).toBeLessThan(0);
    expect(bounce.pos.z).toBeLessThan(0);
    expect(bounce.pos.z).toBeGreaterThan(-COURT.serviceLine);
    // The toss would have come back to the release height 1.1 s after it went up.
    expect(apex - tossAt).toBeCloseTo(550, -1);
    expect(releaseY).toBe(1.5);
  });

  it('an unhit toss is simply tossed again, without a fault', () => {
    const s = sim({}, { firstServer: 'near' });
    s.m.swing({ player: 0, t: s.now, power: 0.3, spin: 0 });
    s.until(() => s.m.view().phase === 'serve-wait', 200);
    expect(s.log.some((x) => x.e.type === 'fault')).toBe(false);
    expect(s.m.view().serveNumber).toBe(1);
  });

  it('two serves struck too late (ball too low) are a double fault', () => {
    const s = sim({}, { firstServer: 'near' });
    for (const serveNumber of [1, 2] as const) {
      s.until(() => s.m.view().phase === 'serve-wait' && s.m.view().message === null, 400);
      s.m.swing({ player: 0, t: s.now, power: 0.3, spin: 0 });
      const tossAt = s.now;
      s.step();
      stepTo(s, tossAt + 1100);
      s.m.swing({ player: 0, t: tossAt + 1100, power: 0.8, spin: 0 });
      const fault = s.untilEvent('fault', 200);
      expect(fault.serveNumber).toBe(serveNumber);
      expect(s.log.some((x) => x.e.type === 'net')).toBe(true);
      if (serveNumber === 1) {
        expect(s.m.view().message).toBe('Fault');
        expect(s.m.view().serveNumber).toBe(2);
      }
    }
    const point = s.log.find((x) => x.e.type === 'point')!.e;
    expect(point).toEqual({ type: 'point', winner: 'far', reason: 'double-fault' });
    expect(s.m.view().message).toBe('Double fault');
  });

  it('the CPU serves on its own after about a second', () => {
    const s = sim();
    expect(s.m.view().serverIndex).toBe(1);
    const start = s.now;
    s.untilEvent('toss', 200);
    expect(s.now - start).toBeGreaterThanOrEqual(1000);
    expect(s.now - start).toBeLessThan(1000 + 2 * FRAME);
    s.untilEvent('hit', 200);
    expect(s.m.view().players[0].receiving).toBe(true);
  });
});

/** A scripted human: tosses at once when serving and swings exactly at T*. */
function playMatch(config: Partial<MatchConfig>, maxFrames: number) {
  const s = sim(config);
  const humans = config.mode === 'doubles' ? (config.humans === 2 ? [0, 1] : [0]) : [0];
  const swung = new Map<number, number>();
  let frames = 0;
  const points: MatchEvent[] = [];
  for (; frames < maxFrames && s.m.view().phase !== 'match-over'; frames++) {
    for (const e of s.step()) if (e.type === 'point') points.push(e);
    const v = s.m.view();
    for (const h of humans) {
      if (v.phase === 'serve-wait' && v.serverIndex === h && v.message === null) {
        s.m.swing({ player: h, t: s.now, power: 0.6, spin: 0.3 });
        continue;
      }
      const tStar = s.m.expectedContact(h);
      if (tStar !== null && tStar <= s.now && swung.get(h) !== tStar) {
        s.m.swing({ player: h, t: tStar, power: 0.6, spin: 0.3 });
        swung.set(h, tStar);
      }
    }
  }
  return { s, frames, points };
}

describe('match: full matches', () => {
  it('a set against the CPU runs to match-over with a seeded RNG', () => {
    const { s, frames, points } = playMatch({ seed: 7, length: 'set1' }, 60 * 60 * 30);
    const v = s.m.view();
    expect(v.phase).toBe('match-over');
    expect(frames).toBeLessThan(60 * 60 * 30);
    expect(v.winner).not.toBeNull();
    const [a, b] = v.score.games;
    expect(Math.max(a, b)).toBeGreaterThanOrEqual(6);
    expect(v.score.sets).toEqual(v.score.games);
    expect(v.message).toMatch(/^Match, /);
    expect(points.length).toBeGreaterThanOrEqual(24);
    expect(v.stats.longestRally).toBeGreaterThan(2);
    expect(v.stats.fastestShotKmh).toBeGreaterThan(0);
    expect(s.log.filter((x) => x.e.type === 'match')).toHaveLength(1);
    // Same seed, same match.
    const again = playMatch({ seed: 7, length: 'set1' }, 60 * 60 * 30);
    expect(again.frames).toBe(frames);
    expect(again.s.m.view().score).toEqual(v.score);
  });

  it('game1 and games3 end at the right number of games', () => {
    const one = playMatch({ seed: 11, length: 'game1', level: 'club' }, 60 * 60 * 10).s.m.view();
    expect(one.phase).toBe('match-over');
    expect(Math.max(...one.score.games)).toBe(1);
    const three = playMatch({ seed: 12, length: 'games3', level: 'pro' }, 60 * 60 * 20).s.m.view();
    expect(three.phase).toBe('match-over');
    expect(Math.max(...three.score.games)).toBe(3);
  });

  it('doubles with two humans and CPU opponents runs to the end, each covering a half', () => {
    const { s } = playMatch({ seed: 5, mode: 'doubles', humans: 2, length: 'games3' }, 60 * 60 * 20);
    const v = s.m.view();
    expect(v.phase).toBe('match-over');
    expect(v.players).toHaveLength(4);
    expect(v.players.map((p) => p.human)).toEqual([true, true, false, false]);
    expect(v.players.map((p) => p.side)).toEqual(['near', 'near', 'far', 'far']);
    const hitters = new Set(s.log.flatMap((x) => (x.e.type === 'hit' ? [x.e.player] : [])));
    expect([...hitters].sort()).toEqual([0, 1, 2, 3]);
  });

  it('uses names and colours from the config, with defaults', () => {
    const named = createMatch({ ...BASE, mode: 'doubles', humans: 2, names: ['Gustav'], colors: ['#123456'] });
    const players = named.view().players;
    expect(players[0].name).toBe('Gustav');
    expect(players[0].color).toBe('#123456');
    expect(players[1].name).toBe('Player 2');
    expect(players[1].color).toMatch(/^#/);
    expect(players[2].name).toBe('CPU 1');
  });
});
