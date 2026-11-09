/**
 * The contract between the game rules (match.ts and friends) and the
 * presentation (render.ts, audio.ts, ui.ts). The rules know nothing about
 * Three.js or the DOM; the presentation never changes game state.
 *
 * Units: metres, seconds for physics; milliseconds of host time
 * (performance.now) for anything the match is told or reports.
 * Court axes (DESIGN.md section 5): y up, net on z = 0, the near side
 * (camera, human players) is z > 0, near baseline z = +11.885.
 */

export interface Vec3 { x: number; y: number; z: number }

export type Side = 'near' | 'far';
export type Level = 'rookie' | 'club' | 'pro';
export type HitWindow = 'easy' | 'normal' | 'pro';
export type MatchLength = 'game1' | 'games3' | 'set1';

export const COURT = {
  halfLength: 11.885,
  singlesHalfWidth: 4.115,
  doublesHalfWidth: 5.485,
  serviceLine: 6.4,
  netHeight: 0.95,
  ballRadius: 0.033,
  /** Drawn size, larger than life so it reads on a TV across the room. */
  ballDrawRadius: 0.06,
} as const;

export interface MatchConfig {
  mode: 'singles' | 'doubles';
  /** Human players, all on the near side in v1: 1 (singles or doubles) or 2 (doubles). */
  humans: 1 | 2;
  names?: string[];
  colors?: string[];
  level: Level;
  window: HitWindow;
  length: MatchLength;
  /** Seed for the match's random numbers, so tests are repeatable. */
  seed?: number;
}

/** One swing by a human, already in host time (phone clock offset applied). */
export interface SwingInput {
  /** Index into MatchView.players. */
  player: number;
  /** Host time (ms) of the contact moment: the swing's peak. May be up to 300 ms in the past. */
  t: number;
  /** 0..1 */
  power: number;
  /** -1 (slice) .. +1 (topspin) */
  spin: number;
}

export interface PlayerView {
  id: number;
  side: Side;
  human: boolean;
  name: string;
  color: string;
  pos: Vec3;
  /** Which stroke the player is set up for, chosen by the game from the ball's side. */
  stance: 'ready' | 'forehand' | 'backhand' | 'serve';
  /** Host time (ms) of this player's last swing or hit, for the swing animation; null if none yet. */
  lastSwingAt: number | null;
  /** True when this player is the one expected to hit the incoming ball. */
  receiving: boolean;
}

export interface BallView {
  pos: Vec3;
  vel: Vec3;
  spin: number;
  visible: boolean;
  /** Bounces since the last hit. */
  bounces: number;
  /** Predicted first landing point of the current flight, for the bounce marker; null if none. */
  landing: Vec3 | null;
}

export interface ScoreView {
  /** Display strings for the current game, near then far: "0" "15" "30" "40" "AD", or tiebreak numbers. */
  points: [string, string];
  games: [number, number];
  /** Games won in completed sets, near then far (one set in v1, kept for later). */
  sets: [number, number];
  server: Side;
  tiebreak: boolean;
  /** Short line for the score bug, e.g. "Deuce", "Advantage near", "Game point", "". */
  callout: string;
}

export type Phase = 'serve-wait' | 'toss' | 'rally' | 'point-over' | 'match-over';

export interface MatchView {
  phase: Phase;
  players: PlayerView[];
  ball: BallView;
  score: ScoreView;
  /** Shots in the current rally. */
  rally: number;
  /** Index of the player who serves next / is serving. */
  serverIndex: number;
  /** Which serve: 1 or 2. */
  serveNumber: 1 | 2;
  /** A short line to show big, e.g. "Out", "Fault", "Ace", "Game, Gustav"; null for none. */
  message: string | null;
  winner: Side | null;
  stats: { longestRally: number; fastestShotKmh: number };
}

export type MatchEvent =
  | { type: 'toss'; player: number }
  | { type: 'hit'; player: number; quality: number; power: number; spin: number; u: number; speedKmh: number }
  | { type: 'whiff'; player: number }
  | { type: 'bounce'; pos: Vec3; in: boolean }
  | { type: 'net' }
  | { type: 'fault'; serveNumber: 1 | 2 }
  | { type: 'point'; winner: Side; reason: 'winner' | 'out' | 'net' | 'double-fault' | 'missed' | 'ace' }
  | { type: 'game'; winner: Side }
  | { type: 'match'; winner: Side };

export interface Match {
  /** Advance to host time `now` (ms) and return what happened since the last call. */
  update(now: number): MatchEvent[];
  /** A human swung. Swings outside the hit window are ignored, not whiffs (DESIGN.md section 5). */
  swing(input: SwingInput): void;
  view(): MatchView;
}
