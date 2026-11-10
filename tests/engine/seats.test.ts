import { describe, expect, it, vi } from 'vitest';
import { LEVELS, cpuShot, stanceFor } from '../../src/engine/ai';
import { HIT_WINDOW_MS, createMatch, makePlayers } from '../../src/engine/match';
import { CAST, characterOf, cpuTuning } from '../../src/engine/personalities';
import { createRng, gauss } from '../../src/engine/rng';
import type { CpuStyle, Level, MatchConfig, MatchEvent, SeatConfig } from '../../src/engine/types';
import { runMatch, steadyBot, type Bot } from '../../src/sim/runner';

// Whole simulated matches: quick on a free machine, slow when the laptop is busy with other work.
vi.setConfig({ testTimeout: 120_000 });

/** Seats (docs/v2/PLAN.md M1): any player human or CPU on either side, characters, per-player stats. */

const base = (seats: SeatConfig[], extra: Partial<MatchConfig> = {}): MatchConfig => ({
  mode: seats.length === 2 ? 'singles' : 'doubles', seats, level: 'club', window: 'normal', length: 'games3', seed: 7, ...extra,
});
const human = (side: 'near' | 'far', name: string, extra: Partial<SeatConfig> = {}): SeatConfig => ({ side, human: true, name, ...extra });
const cpu = (side: 'near' | 'far', style: CpuStyle = 'allround', level?: Level): SeatConfig => ({ side, human: false, style, level });
/**
 * A seeded bot whose timing error is normal with this sd (ms), like a person's. Two bots with a bounded, uniform
 * error never miss and rally for ever, because every swing meets the string bed.
 */
const jitterBot = (seed: number, sd: number, power = 0.6, spin = 0.3): Bot => {
  const rng = createRng(seed);
  return steadyBot(() => gauss(rng, sd), power, spin);
};
const points = (events: { e: MatchEvent }[]) => events.map((x) => x.e).filter((e) => e.type === 'point') as Extract<MatchEvent, { type: 'point' }>[];

describe('seats', () => {
  it('builds the v1 shape exactly as before: one human near, a plain CPU far', () => {
    const players = makePlayers({ mode: 'singles', humans: 1, level: 'pro', window: 'easy', length: 'game1', names: ['Gustav'] });
    expect(players.map((p) => [p.side, p.human, p.name])).toEqual([['near', true, 'Gustav'], ['far', false, 'CPU']]);
    expect(players[1].cpu).toBe(LEVELS.pro);
    expect(players[0].window).toBe(HIT_WINDOW_MS.easy);
  });

  it('orders players near side first and gives doubles halves', () => {
    const players = makePlayers(base([cpu('far', 'wall'), human('near', 'A'), cpu('far', 'fox'), human('near', 'B')]));
    expect(players.map((p) => `${p.side}:${p.half}:${p.name}`)).toEqual(['near:-1:A', 'near:1:B', 'far:-1:The Wall', 'far:1:The Fox']);
  });

  it('rejects a seat list that does not fill both sides', () => {
    expect(() => makePlayers(base([human('near', 'A'), human('near', 'B')]))).toThrow(/each side/);
    expect(() => makePlayers(base([human('near', 'A'), cpu('far'), cpu('far')], { mode: 'doubles' }))).toThrow(/each side/);
  });

  it('labels each side by its humans, or by its CPU characters when it has none', () => {
    const m = createMatch(base([human('near', 'Gustav'), cpu('far', 'cannon')]));
    m.update(1000);
    expect(m.view().labels).toEqual(['Gustav', 'The Cannon']);
    const versus = createMatch(base([human('near', 'Gustav'), human('far', 'Ramy')]));
    versus.update(1000);
    expect(versus.view().labels).toEqual(['Gustav', 'Ramy']);
  });

  it('gives each human their own timing window', () => {
    const players = makePlayers(base([human('near', 'Kid', { window: 'easy' }), human('far', 'Dad', { window: 'pro' })]));
    expect(players[0].window).toBe(HIT_WINDOW_MS.easy);
    expect(players[1].window).toBe(HIT_WINDOW_MS.pro);
  });

  it('mirrors forehand and backhand for a left-hander', () => {
    expect(stanceFor('near', 0, 1)).toBe('forehand');
    expect(stanceFor('near', 0, 1, true)).toBe('backhand');
    expect(stanceFor('far', 0, 1)).toBe('backhand');
    expect(stanceFor('far', 0, 1, true)).toBe('forehand');
  });
});

describe('versus: humans on both sides', () => {
  it('plays a whole singles match between two scripted humans, both serving and both scoring', () => {
    const m = createMatch(base([human('near', 'Gustav'), human('far', 'Ramy')], { length: 'set1' }));
    const r = runMatch(m, { 0: jitterBot(1, 70), 1: jitterBot(2, 70) });
    expect(r.timedOut).toBe(false);
    expect(r.view.winner).not.toBeNull();
    const p = points(r.events);
    expect(p.some((e) => e.winner === 'near')).toBe(true);
    expect(p.some((e) => e.winner === 'far')).toBe(true);
    const servers = new Set(r.events.filter((x) => x.e.type === 'toss').map((x) => (x.e as Extract<MatchEvent, { type: 'toss' }>).player));
    expect([...servers].sort()).toEqual([0, 1]);
    // The far human's swings went through the contact model like the near human's.
    const farHits = r.shots.filter((s) => s.player === 1 && s.outcome === 'hit');
    expect(farHits.length).toBeGreaterThan(10);
  });

  it('is symmetric: equal players on either end win about as often', () => {
    let near = 0;
    const N = 40;
    for (let seed = 0; seed < N; seed++) {
      const m = createMatch(base([human('near', 'A'), human('far', 'B')], { seed, length: 'games3' }), {
        firstServer: seed % 2 === 0 ? 'near' : 'far',
      });
      const r = runMatch(m, { 0: jitterBot(100 + seed, 70), 1: jitterBot(900 + seed, 70) });
      expect(r.timedOut).toBe(false);
      if (r.view.winner === 'near') near++;
    }
    expect(near).toBeGreaterThanOrEqual(N * 0.3);
    expect(near).toBeLessThanOrEqual(N * 0.7);
  });

  it('plays two against two with four scripted humans', () => {
    const m = createMatch(base([human('near', 'A'), human('near', 'B'), human('far', 'C'), human('far', 'D')]));
    const r = runMatch(m, { 0: jitterBot(1, 70), 1: jitterBot(2, 70), 2: jitterBot(3, 70), 3: jitterBot(4, 70) });
    expect(r.timedOut).toBe(false);
    for (const player of [0, 1, 2, 3]) {
      expect(r.shots.filter((s) => s.player === player && s.outcome === 'hit').length, `player ${player} hit the ball`).toBeGreaterThan(0);
    }
    expect(r.view.labels).toEqual(['A & B', 'C & D']);
  });

  it('fills an empty versus seat with a CPU partner', () => {
    const m = createMatch(base([human('near', 'A'), cpu('near'), human('far', 'C'), cpu('far', 'wall')]));
    const r = runMatch(m, { 0: jitterBot(1, 70), 2: jitterBot(3, 70) });
    expect(r.timedOut).toBe(false);
    expect(r.view.labels).toEqual(['A', 'C']);
  });
});

describe('stats and richer events', () => {
  const m = createMatch(base([human('near', 'Gustav'), cpu('far', 'allround', 'rookie')], { length: 'set1', seed: 3 }));
  const r = runMatch(m, { 0: { swing: () => ({ dt: 0, power: 0.7, spin: 0.3, omega: 1100 }) } });
  const stats = r.view.stats;

  it('counts points per side and credits each point to a player', () => {
    const p = points(r.events);
    expect(stats.points[0] + stats.points[1]).toBe(p.length);
    expect(p.every((e) => e.by === 0 || e.by === 1)).toBe(true);
    const winners = p.filter((e) => e.reason === 'winner' || e.reason === 'ace');
    const errors = p.filter((e) => e.reason !== 'winner' && e.reason !== 'ace');
    expect(stats.players[0].winners + stats.players[1].winners).toBe(winners.length);
    expect(stats.players[0].errors + stats.players[1].errors).toBe(errors.length);
    // The player credited with an error is on the losing side of that point, and with a winner on the winning side.
    for (const e of p) {
      const side = e.by === 0 ? 'near' : 'far';
      expect(side === e.winner).toBe(e.reason === 'winner' || e.reason === 'ace');
    }
  });

  it('counts hits per player and keeps the fastest swing a phone reported', () => {
    const hits = r.events.filter((x) => x.e.type === 'hit') as { e: Extract<MatchEvent, { type: 'hit' }> }[];
    expect(stats.players[0].hits).toBe(hits.filter((h) => h.e.player === 0).length);
    expect(stats.players[1].hits).toBe(hits.filter((h) => h.e.player === 1).length);
    expect(stats.players[0].fastestSwing).toBe(1100);
    expect(stats.players[1].fastestSwing).toBe(0);
    expect(stats.fastestShotKmh).toBe(stats.players[0].fastestShotKmh);
  });

  it('reports the rally length with every point and the stroke with every hit', () => {
    expect(points(r.events).every((e) => Number.isInteger(e.rally) && e.rally >= 0)).toBe(true);
    const hits = r.events.filter((x) => x.e.type === 'hit').map((x) => x.e as Extract<MatchEvent, { type: 'hit' }>);
    expect(hits.some((h) => h.stroke === 'serve')).toBe(true);
    expect(hits.some((h) => h.stroke === 'forehand')).toBe(true);
    expect(hits.every((h) => Number.isFinite(h.t))).toBe(true);
    expect(Math.max(...points(r.events).map((e) => e.rally))).toBe(stats.longestRally);
  });
});

describe('CPU characters', () => {
  it('has a distinct cast, each with a name, a trait and a tip', () => {
    expect(new Set(CAST.map((c) => c.style)).size).toBe(CAST.length);
    expect(new Set(CAST.map((c) => c.name)).size).toBe(CAST.length);
    for (const c of CAST) expect(c.trait.length > 0 && c.tip.length > 0).toBe(true);
    expect(characterOf('fox').name).toBe('The Fox');
  });

  it('keeps the plain level untouched for the all-rounder', () => {
    for (const level of ['rookie', 'club', 'pro'] as const) expect(cpuTuning('allround', level)).toBe(LEVELS[level]);
  });

  it('bends each character the way its trait says, at every level', () => {
    for (const level of ['rookie', 'club', 'pro'] as const) {
      const L = LEVELS[level];
      const wall = cpuTuning('wall', level), cannon = cpuTuning('cannon', level), fox = cpuTuning('fox', level), ace = cpuTuning('ace', level);
      expect(wall.speed).toBeGreaterThan(L.speed);
      expect(wall.mishit).toBeLessThan(L.mishit);
      expect(wall.attack).toBe(0);
      expect(cannon.flight[0]).toBeLessThan(L.flight[0]);
      expect(cannon.mishit).toBeGreaterThan(L.mishit);
      expect(cannon.attack).toBeGreaterThan(L.attack);
      expect(fox.dropShot).toBeGreaterThan(0);
      expect(fox.aim[1]).toBeGreaterThanOrEqual(L.aim[1]);
      expect(ace.servePower[0]).toBeGreaterThan(L.servePower[0]);
      expect(ace.servePower[0]).toBeLessThanOrEqual(1);
    }
  });

  it('plays drop shots only as the Fox, and only against a deep receiver', () => {
    const count = (style: CpuStyle, depth: number | null) => {
      const rng = createRng(11);
      let drops = 0;
      for (let i = 0; i < 2000; i++) {
        const shot = cpuShot(cpuTuning(style, 'pro'), rng, 'far', 4.115, 1.5, 0, depth);
        if (!shot.intoNet && Math.abs(shot.target.z) < 4.5 && shot.spin < 0) drops++;
      }
      return drops;
    };
    expect(count('fox', 12.6)).toBeGreaterThan(300);
    expect(count('fox', 6)).toBe(0);
    expect(count('fox', null)).toBe(0);
    expect(count('allround', 12.6)).toBe(0);
  });

  it('draws the same random numbers as v1 for the plain levels, so old seeds replay', () => {
    const a = createRng(5), b = createRng(5);
    for (let i = 0; i < 200; i++) {
      expect(cpuShot('club', a, 'far', 4.115, 1, 0.3)).toEqual(cpuShot(LEVELS.club, b, 'far', 4.115, 1, 0.3, 12.6));
    }
  });

  it('finishes whole matches against every character at every level', () => {
    for (const style of CAST.map((c) => c.style)) {
      for (const level of ['rookie', 'club', 'pro'] as const) {
        const m = createMatch(base([human('near', 'Gustav'), cpu('far', style, level)], { length: 'games3', seed: 21 }));
        const r = runMatch(m, { 0: jitterBot(4, 60) });
        expect(r.timedOut, `${style} ${level}`).toBe(false);
      }
    }
  });
});
