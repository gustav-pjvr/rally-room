import { describe, expect, it } from 'vitest';
import {
  ACCEPT, HIT_WINDOW_MS, MISS_GRACE_MS, TOSS, createMatch, type GameMatch, type MatchOptions,
} from '../../src/engine/match';
import { COURT, type MatchConfig, type MatchEvent } from '../../src/engine/types';

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
    // Perfect timing meets the sweet spot, give or take the small placement noise.
    expect(hit.contact.frame).toBe(false);
    expect(Math.abs(hit.contact.a + 0.15)).toBeLessThan(0.2);
    expect(Math.abs(hit.contact.b)).toBeLessThan(0.2);
    expect(hit.quality).toBeGreaterThan(0.85);
    expect(hit.speedKmh).toBeGreaterThan(30);
    expect(s.m.view().rally).toBe(2);
    const landing = s.m.view().ball.landing!;
    expect(landing.z).toBeLessThan(0);
    const bounce = s.untilEvent('bounce');
    expect(bounce.in).toBe(true);
    expect(bounce.pos.z).toBeLessThan(0);
    expect(bounce.pos.z).toBeCloseTo(landing.z, 6);
    // Perfect timing aims at the middle; a centred contact adds almost no direction error.
    expect(Math.abs(bounce.pos.x)).toBeLessThan(0.5);
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
      // Early reaches toward the tip, late is cramped toward the throat; both are off the sweet spot.
      if (u < 0) expect(hit.contact.a).toBeGreaterThan(0.2);
      else expect(hit.contact.a).toBeLessThan(-0.35);
      expect(hit.quality).toBeGreaterThan(0.2);
      expect(hit.quality).toBeLessThan(0.8);
      const bounce = s.untilEvent('bounce');
      expect(bounce.in).toBe(true);
      // Early (u < 0): the opposite side to the contact. Late: the same side. Aim 0.6 * 0.75 * half width, plus scatter.
      expect(Math.sign(bounce.pos.x)).toBe(u < 0 ? -hitSide : hitSide);
      expect(Math.abs(Math.abs(bounce.pos.x) - 0.6 * 0.75 * COURT.singlesHalfWidth)).toBeLessThan(1.5);
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

  it('with no swing the point is lost only after T* + ACCEPT * W + 300 ms', () => {
    const s = sim();
    const tStar = toRallyIncoming(s);
    const before = s.log.length;
    const point = s.untilEvent('point');
    expect(point).toMatchObject({ type: 'point', winner: 'far', reason: 'missed' });
    const when = s.log.slice(before).find((x) => x.e.type === 'point')!.now;
    expect(when).toBeGreaterThanOrEqual(tStar + ACCEPT * W + MISS_GRACE_MS);
    expect(when).toBeLessThan(tStar + ACCEPT * W + MISS_GRACE_MS + FRAME + 1e-6);
    expect(s.m.view().phase).toBe('point-over');
    expect(s.m.view().message).toBe('Missed');
  });

  it('an unreturned serve is an ace', () => {
    const s = sim();
    toIncoming(s);
    expect(s.untilEvent('point')).toMatchObject({ type: 'point', winner: 'far', reason: 'ace' });
    expect(s.m.view().score.points).toEqual(['0', '15']);
  });

  it('lag compensation: a swing reported 150 ms late still hits from where the ball was', () => {
    const s = sim();
    const tStar = toIncoming(s);
    stepTo(s, tStar + 150);
    s.m.swing({ player: 0, t: tStar, power: 0.6, spin: 0.3 });
    const hit = s.untilEvent('hit');
    expect(hit.quality).toBeGreaterThan(0.85);
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

  it('the window depends on the setting: 160 ms late touches the ball on easy, is ignored on pro', () => {
    // Easy accepts 1.6 * 180 = 288 ms; pro 1.6 * 90 = 144 ms.
    for (const [window, hits] of [['easy', true], ['pro', false]] as const) {
      const s = sim({ window });
      const tStar = toIncoming(s);
      stepTo(s, tStar + 160);
      s.m.swing({ player: 0, t: tStar + 160, power: 0.5, spin: 0 });
      const events = s.step();
      expect(events.some((e) => e.type === 'hit')).toBe(hits);
      expect(events.some((e) => e.type === 'whiff')).toBe(false);
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
    expect(hit.quality).toBeGreaterThan(0.85);
    expect(hit.contact.frame).toBe(false);
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
    expect(point).toMatchObject({ type: 'point', winner: 'far', reason: 'double-fault' });
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

describe('match: the contact point (DESIGN.md section 5)', () => {
  /** Swing once at T* + k * W for seeds 1..n; returns what the swing produced. */
  function swingAt(k: number, spin: number, n = 20, power = 0.6) {
    const out: { hit?: Extract<MatchEvent, { type: 'hit' }>; whiff: boolean; s: Sim; tStar: number }[] = [];
    for (let seed = 1; seed <= n; seed++) {
      const s = sim({ seed });
      const tStar = toIncoming(s);
      const t = tStar + k * W;
      stepTo(s, t);
      s.m.swing({ player: 0, t, power, spin });
      const events = s.step();
      const hit = events.find((e) => e.type === 'hit') as Extract<MatchEvent, { type: 'hit' }> | undefined;
      out.push({ hit, whiff: events.some((e) => e.type === 'whiff'), s, tStar });
    }
    return out;
  }

  it('a late swing past the bed edge hits the frame: weak, quality 0.05, r between 1 and 1.25', () => {
    // Full-power swings: the frame takes the pace off (a shank is a slow, loopy ball or one into the net).
    const centred = swingAt(0, 0.3, 20, 1).map((x) => x.hit!);
    const late = swingAt(1.3, 0, 20, 1);
    const frames = late.flatMap((x) => (x.hit?.contact.frame ? [x.hit] : []));
    expect(frames.length).toBeGreaterThanOrEqual(10);
    for (const f of frames) {
      expect(f.quality).toBe(0.05);
      const r = Math.hypot(f.contact.a, f.contact.b);
      expect(r).toBeGreaterThan(1);
      expect(r).toBeLessThanOrEqual(1.25);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(frames.map((f) => f.speedKmh))).toBeLessThan(mean(centred.map((h) => h.speedKmh)) * 0.6);
    expect(centred.every((h) => !h.contact.frame && h.quality > 0.8)).toBe(true);
  });

  it('beyond the frame is a clean miss: a whiff, the ball stays in play and the point is lost', () => {
    const results = swingAt(1.55, 0);
    const whiffs = results.filter((x) => x.whiff);
    expect(whiffs.length).toBeGreaterThanOrEqual(10);
    for (const { s, hit } of whiffs) {
      expect(hit).toBeUndefined();
      expect(s.m.view().phase).toBe('rally');
      // The incoming ball here is the CPU's serve, so the unreturned ball is an ace.
      expect(s.untilEvent('point')).toMatchObject({ type: 'point', winner: 'far' });
      expect(s.log.filter((x) => x.e.type === 'point').map((x) => (x.e as { reason: string }).reason)).toEqual(['ace']);
    }
  });

  it('an early whiff does not end the chance: the real swing after it still hits', () => {
    const s = sim();
    const tStar = toIncoming(s);
    // 1.5 W early with full topspin: a = 1.35, b = 1.05, far off the frame.
    stepTo(s, tStar - 1.5 * W);
    s.m.swing({ player: 0, t: tStar - 1.5 * W, power: 0.9, spin: 1 });
    expect(s.step().some((e) => e.type === 'whiff')).toBe(true);
    stepTo(s, tStar);
    s.m.swing({ player: 0, t: tStar, power: 0.5, spin: 0.2 });
    const hit = s.untilEvent('hit', 2);
    expect(hit.player).toBe(0);
    expect(hit.contact.frame).toBe(false);
    expect(s.m.view().rally).toBe(2);
  });

  it('a stronger swing that would whiff never undoes a hit', () => {
    const s = sim();
    const tStar = toIncoming(s);
    stepTo(s, tStar);
    s.m.swing({ player: 0, t: tStar, power: 0.4, spin: 0.2 });
    expect(s.step().some((e) => e.type === 'hit')).toBe(true);
    const t = tStar + 1.58 * W;
    stepTo(s, t);
    s.m.swing({ player: 0, t, power: 1, spin: 1 });
    const events = s.step();
    expect(events.some((e) => e.type === 'hit' || e.type === 'whiff')).toBe(false);
    expect(s.m.view().ball.vel.z).toBeLessThan(0);
  });

  it('a swing just outside the acceptance window is still ignored (not a whiff)', () => {
    for (const k of [-1.65, 1.65]) {
      const s = sim();
      const tStar = toIncoming(s);
      stepTo(s, tStar + k * W);
      s.m.swing({ player: 0, t: tStar + k * W, power: 1, spin: 0 });
      expect(s.step().some((e) => e.type === 'hit' || e.type === 'whiff'), `k ${k}`).toBe(false);
    }
  });

  it('serve contact: the top of the toss is clean; a late serve is low on the face toward the throat', () => {
    const top = sim({}, { firstServer: 'near' });
    top.m.swing({ player: 0, t: top.now, power: 0.3, spin: 0 });
    top.step();
    const apex = top.m.expectedContact(0)!;
    stepTo(top, apex);
    top.m.swing({ player: 0, t: apex, power: 0.6, spin: 0 });
    const clean = top.untilEvent('hit', 2);
    expect(clean.contact.frame).toBe(false);
    expect(Math.abs(clean.contact.a + 0.15)).toBeLessThan(0.2);

    const s = sim({}, { firstServer: 'near' });
    s.m.swing({ player: 0, t: s.now, power: 0.3, spin: 0 });
    const tossAt = s.now;
    s.step();
    // 400 ms after the top of the toss: the ball has dropped about 0.8 m but is still above 1.9 m.
    const t = tossAt + 950;
    stepTo(s, t);
    expect(s.m.view().ball.pos.y).toBeGreaterThan(1.9);
    s.m.swing({ player: 0, t, power: 0.6, spin: 0 });
    const late = s.untilEvent('hit', 2);
    expect(late.contact.a).toBeLessThan(-0.5);
    expect(late.contact.b).toBeLessThan(-0.3);
    expect(late.quality).toBeLessThan(clean.quality);
  });

  it('CPUs use the same model: every CPU hit carries a contact, and a Rookie sometimes mishits', () => {
    const { s } = playMatch({ seed: 21, level: 'rookie', length: 'set1' }, 60 * 60 * 30);
    const cpuHits = s.log.flatMap((x) => (x.e.type === 'hit' && x.e.player === 1 ? [x.e] : []));
    expect(cpuHits.length).toBeGreaterThan(50);
    expect(cpuHits.every((h) => Number.isFinite(h.contact.a) && Number.isFinite(h.contact.b))).toBe(true);
    const mishits = cpuHits.filter((h) => h.contact.frame).length
      + s.log.filter((x) => x.e.type === 'whiff' && x.e.player === 1).length;
    expect(mishits).toBeGreaterThan(0);
    expect(new Set(cpuHits.map((h) => Math.round(h.quality * 10))).size).toBeGreaterThan(3);
  });
});

describe('match: a ball that has bounced twice is dead (DESIGN.md sections 3 and 5)', () => {
  /** Step until the incoming ball's second bounce is reported (or the point ends); returns the first frame at or after it. */
  function toSecondBounce(s: Sim): number {
    s.until(() => s.m.view().ball.bounces >= 2 || s.m.view().phase !== 'rally');
    return s.now;
  }

  for (const window of ['easy', 'normal'] as const) {
    for (const kind of ['serve', 'rally'] as const) {
      it(`${window}, ${kind}: a swing at or after the second bounce never hits`, () => {
        let scanned = 0;
        for (let seed = 1; seed <= 80; seed++) {
          const s = sim({ seed, window });
          try {
            if (kind === 'serve') toIncoming(s);
            else toRallyIncoming(s);
          } catch {
            continue;
          }
          const hitsBefore = s.log.filter((x) => x.e.type === 'hit').length;
          const t = toSecondBounce(s);
          if (s.m.view().phase !== 'rally') continue;
          scanned++;
          s.m.swing({ player: 0, t, power: 0.6, spin: 0 });
          const events = s.step();
          expect(events.some((e) => e.type === 'hit'), `seed ${seed}`).toBe(false);
          expect(s.log.filter((x) => x.e.type === 'hit').length, `seed ${seed}`).toBe(hitsBefore);
        }
        expect(scanned).toBeGreaterThanOrEqual(4);
      });
    }
  }

  it('with no swing the point ends no later than the second bounce plus the grace', () => {
    for (const window of ['easy', 'normal'] as const) {
      for (let seed = 1; seed <= 20; seed++) {
        const s = sim({ seed, window });
        toIncoming(s);
        const second = toSecondBounce(s);
        const before = s.log.length;
        if (s.m.view().phase === 'rally') s.untilEvent('point');
        const found = s.log.slice(before).find((x) => x.e.type === 'point');
        const when = found ? found.now : second;
        expect(when, `${window} seed ${seed}`).toBeLessThanOrEqual(second + MISS_GRACE_MS + FRAME + 1e-6);
      }
    }
  });
});
