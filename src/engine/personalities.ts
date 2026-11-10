import { LEVELS, type LevelTuning } from './ai';
import type { CpuStyle, Level } from './types';

/**
 * CPU characters. Each one is a level's tuning (ai.ts LEVELS) bent toward one
 * way of playing, so the same character exists at Rookie, Club and Pro. They
 * are original to this game: a way of playing with a nickname, not a person.
 *
 * 'allround' is the plain level, exactly as v1 played.
 */
export interface Character {
  style: CpuStyle;
  /** Nickname shown in the lobby and on the score. */
  name: string;
  /** One line on how they play, and one on how to beat them. */
  trait: string;
  tip: string;
}

export const CAST: Character[] = [
  { style: 'allround', name: 'The Regular', trait: 'Does a bit of everything.', tip: 'Outlast them or out-hit them.' },
  { style: 'wall', name: 'The Wall', trait: 'Gets everything back, high and deep.', tip: 'Be patient and use the angles.' },
  { style: 'cannon', name: 'The Cannon', trait: 'Hits flat and hard, and misses a few.', tip: 'Keep the ball in and let them miss.' },
  { style: 'fox', name: 'The Fox', trait: 'Sharp angles, slice and the odd drop shot.', tip: 'Stay ready to run forward.' },
  { style: 'ace', name: 'The Ace', trait: 'A huge first serve, an ordinary rally.', tip: 'Get the return in play.' },
];

export const characterOf = (style: CpuStyle): Character => CAST.find((c) => c.style === style) ?? CAST[0];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const pair = (r: [number, number], f: (v: number) => number): [number, number] => [f(r[0]), f(r[1])];
const byLevel = (level: Level, rookie: number, club: number, pro: number) =>
  (level === 'rookie' ? rookie : level === 'club' ? club : pro);

/** The tuning a character plays with at a level. */
export function cpuTuning(style: CpuStyle, level: Level): LevelTuning {
  const L = LEVELS[level];
  switch (style) {
    case 'wall':
      // A retriever: quick, long reach, few errors, soft looping balls, never goes for a winner.
      return {
        ...L,
        speed: L.speed * 1.12, reaction: L.reaction * 0.85, reach: L.reach + 0.15,
        timingSd: L.timingSd * 0.8, faceSd: L.faceSd * 0.8,
        flight: pair(L.flight, (v) => v + 0.25), depth: pair(L.depth, (v) => Math.min(10.3, v + 0.5)),
        aim: pair(L.aim, (v) => v * 0.6), spin: [0.5, 0.9],
        aimSd: L.aimSd * 0.8, depthSd: L.depthSd * 0.8, mishit: L.mishit * 0.5,
        openCourt: L.openCourt * 0.6, attack: 0,
        servePower: pair(L.servePower, (v) => v * 0.8), serveSd: pair(L.serveSd, (v) => v * 0.8),
      };
    case 'cannon':
      // A hitter: flat pace and frequent attacks, slower feet, more errors.
      return {
        ...L,
        speed: L.speed * 0.9, reaction: L.reaction * 1.15,
        flight: pair(L.flight, (v) => v * 0.84), depth: pair(L.depth, (v) => Math.min(10.4, v + 0.3)),
        spin: [0, 0.3],
        aimSd: L.aimSd * 1.25, depthSd: L.depthSd * 1.3, mishit: L.mishit * 1.5,
        attack: clamp(L.attack + 0.25, 0.15, 0.6), attackFlight: pair(L.attackFlight, (v) => v * 0.92),
        servePower: pair(L.servePower, (v) => clamp(v + 0.15, 0, 1)), serveSd: pair(L.serveSd, (v) => v * 1.2),
      };
    case 'fox':
      // An angle player: wide targets, the open court, slice, drop shots, serves out wide.
      return {
        ...L,
        aim: [Math.max(L.aim[0], 0.55), Math.max(L.aim[1], 0.9)], spin: [-0.6, 0.4],
        flight: pair(L.flight, (v) => v + 0.05), aimSd: L.aimSd * 0.9,
        openCourt: clamp(L.openCourt + 0.3, 0, 1), attack: L.attack * 0.6,
        dropShot: byLevel(level, 0.1, 0.2, 0.28), serveBias: -0.45,
      };
    case 'ace':
      // A serve specialist: a big first serve, a careful second, works the backhand, a slightly loose rally game.
      return {
        ...L,
        speed: L.speed * 0.95, mishit: L.mishit * 1.2,
        servePower: [clamp(L.servePower[0] * 1.35, 0, 1), L.servePower[1] * 0.9],
        serveSpin: [0.05, L.serveSpin[1]], serveSd: [L.serveSd[0] * 1.1, L.serveSd[1]],
        backhand: byLevel(level, 0.2, 0.35, 0.5),
      };
    default:
      return L;
  }
}
