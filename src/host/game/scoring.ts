import type { MatchLength, ScoreView, Side } from './types';

/**
 * Tennis scoring (DESIGN.md section 5). Index 0 is the near side, 1 the far
 * side. Pure: every function returns a new state.
 *
 * Match lengths: game1 is first to 1 game; games3 is first to 3 games (no
 * tiebreak can be needed); set1 is one set to 6 games, won by 2, with a
 * tiebreak to 7 (won by 2) at 6-6.
 *
 * Serving: the server changes every game. In a tiebreak the player due to
 * serve serves the first point, then the serve changes after every two
 * points (standard rotation: A, BB, AA, BB ...). The serve side alternates
 * every point, deuce court first.
 */

export interface ScoreState {
  length: MatchLength;
  points: [number, number];
  games: [number, number];
  /** Games won in completed sets (DESIGN: one set in v1). */
  sets: [number, number];
  tiebreak: boolean;
  /** Who serves the current point. */
  server: Side;
  /** Who served the first point of the current tiebreak. */
  tiebreakFirst: Side;
  winner: Side | null;
}

export interface PointResult {
  state: ScoreState;
  /** Set when this point finished a game (a tiebreak counts as a game). */
  game: Side | null;
  match: Side | null;
}

export const sideIndex = (side: Side) => (side === 'near' ? 0 : 1);
export const other = (side: Side): Side => (side === 'near' ? 'far' : 'near');
const sideOf = (i: number): Side => (i === 0 ? 'near' : 'far');

export function createScore(length: MatchLength, firstServer: Side = 'near'): ScoreState {
  return {
    length, points: [0, 0], games: [0, 0], sets: [0, 0], tiebreak: false,
    server: firstServer, tiebreakFirst: firstServer, winner: null,
  };
}

/** Points played in the current game (or tiebreak). */
export const pointsPlayed = (s: ScoreState) => s.points[0] + s.points[1];

/** Which court the serve comes from: deuce (right) on even points, ad on odd. */
export const serveCourt = (s: ScoreState): 'deuce' | 'ad' => (pointsPlayed(s) % 2 === 0 ? 'deuce' : 'ad');

/** Tiebreak server for point k (0-based): A, B, B, A, A, B, B ... */
export function tiebreakServer(first: Side, k: number): Side {
  return Math.floor((k + 1) / 2) % 2 === 0 ? first : other(first);
}

function gameWon(points: [number, number], tiebreak: boolean, w: number): boolean {
  const need = tiebreak ? 7 : 4;
  return points[w] >= need && points[w] - points[1 - w] >= 2;
}

function matchWon(length: MatchLength, games: [number, number], w: number): boolean {
  if (length === 'game1') return games[w] >= 1;
  if (length === 'games3') return games[w] >= 3;
  return (games[w] >= 6 && games[w] - games[1 - w] >= 2) || games[w] >= 7;
}

/** Award one point to `side`. */
export function awardPoint(state: ScoreState, side: Side): PointResult {
  if (state.winner) return { state, game: null, match: null };
  const w = sideIndex(side);
  const points: [number, number] = [...state.points];
  points[w]++;
  if (!gameWon(points, state.tiebreak, w)) {
    const server = state.tiebreak ? tiebreakServer(state.tiebreakFirst, points[0] + points[1]) : state.server;
    return { state: { ...state, points, server }, game: null, match: null };
  }
  const games: [number, number] = [...state.games];
  games[w]++;
  // After a tiebreak, the side that received first in it serves next.
  const nextServer = state.tiebreak ? other(state.tiebreakFirst) : other(state.server);
  if (matchWon(state.length, games, w)) {
    const sets: [number, number] = state.length === 'set1' ? [...games] : [...state.sets];
    return {
      state: { ...state, points: [0, 0], games, sets, server: nextServer, winner: side, tiebreak: false },
      game: side, match: side,
    };
  }
  const tiebreak = state.length === 'set1' && games[0] === 6 && games[1] === 6;
  return {
    state: { ...state, points: [0, 0], games, server: nextServer, tiebreak, tiebreakFirst: nextServer },
    game: side, match: null,
  };
}

const CALLS = ['0', '15', '30', '40'];

/** Display strings for the current game, near then far. */
export function pointStrings(s: ScoreState): [string, string] {
  const [a, b] = s.points;
  if (s.tiebreak) return [String(a), String(b)];
  if (a >= 3 && b >= 3) {
    if (a === b) return ['40', '40'];
    return a > b ? ['AD', '40'] : ['40', 'AD'];
  }
  return [CALLS[Math.min(a, 3)], CALLS[Math.min(b, 3)]];
}

/** The short line for the score bug. `labels` name the near and far sides. */
export function callout(s: ScoreState, labels: [string, string] = ['near', 'far']): string {
  if (s.winner) return '';
  for (const i of [0, 1]) {
    const result = awardPoint(s, sideOf(i));
    if (result.match) return 'Match point';
  }
  const [a, b] = s.points;
  if (!s.tiebreak && a >= 3 && b >= 3) {
    if (a === b) return 'Deuce';
    return `Advantage ${labels[a > b ? 0 : 1]}`;
  }
  for (const i of [0, 1]) {
    if (!awardPoint(s, sideOf(i)).game) continue;
    if (s.tiebreak) return 'Set point';
    return sideOf(i) === s.server ? 'Game point' : 'Break point';
  }
  return s.tiebreak ? 'Tiebreak' : '';
}

export function scoreView(s: ScoreState, labels: [string, string] = ['near', 'far']): ScoreView {
  return {
    points: pointStrings(s),
    games: [...s.games],
    sets: [...s.sets],
    server: s.server,
    tiebreak: s.tiebreak,
    callout: callout(s, labels),
  };
}
