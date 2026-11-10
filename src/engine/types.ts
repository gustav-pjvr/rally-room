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

/** CPU characters (personalities.ts). 'allround' is the plain level with no habits. */
export type CpuStyle = 'allround' | 'wall' | 'cannon' | 'fox' | 'ace';

/**
 * One player of a match. Seats are listed near side first, then far; within a
 * doubles side, the player covering x < 0 first. Singles has two seats,
 * doubles four.
 */
export interface SeatConfig {
  side: Side;
  human: boolean;
  name?: string;
  color?: string;
  /** Humans: swings the racket with the left hand (stances mirror). */
  leftHanded?: boolean;
  /** Humans: this player's own timing window; default is the match's `window`. */
  window?: HitWindow;
  /** CPUs: character and level; defaults are 'allround' and the match's `level`. */
  style?: CpuStyle;
  level?: Level;
}

export interface MatchConfig {
  mode: 'singles' | 'doubles';
  /**
   * Every player. When absent, the v1 shape below is used: `humans` humans on
   * the near side against CPUs of `level`.
   */
  seats?: SeatConfig[];
  /** v1 shape: human players, all on the near side: 1 (singles or doubles) or 2 (doubles). */
  humans?: 1 | 2;
  names?: string[];
  colors?: string[];
  /** Default CPU level. */
  level: Level;
  /** Default timing window for humans. */
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
  /** Peak rotation rate of the swing, deg/s, when a phone made it (for the fastest-swing stat). */
  omega?: number;
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
  /** Doubles half: -1 covers x < 0, +1 covers x > 0, 0 in singles. */
  half: -1 | 0 | 1;
  leftHanded: boolean;
  /** CPU character, null for a human. */
  style: CpuStyle | null;
  /** A ball machine (drills), drawn as a machine rather than a figure. */
  machine: boolean;
}

/** What one player did in the match so far. */
export interface PlayerStats {
  hits: number;
  /** Hits with quality of 0.7 or more. */
  sweet: number;
  frames: number;
  whiffs: number;
  /** Points this player won with the last touch (winners and aces). */
  winners: number;
  aces: number;
  /** Points this player lost with the last touch (out, net, double fault, missed). */
  errors: number;
  doubleFaults: number;
  fastestShotKmh: number;
  /** Fastest swing, deg/s at the peak; 0 when no phone swing was seen. */
  fastestSwing: number;
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
  /** longestRally and fastestShotKmh (humans only) as in v1; `players` per player; `points` won per side. */
  stats: { longestRally: number; fastestShotKmh: number; players: PlayerStats[]; points: [number, number] };
  /** Team labels for the score, near then far. */
  labels: [string, string];
  /** Drills only (drill.ts); absent in a match. */
  drill?: DrillView;
}

/** A target on the court for drills: a rectangle on the ground, centre (x, z), `w` wide (x) and `d` deep (z). */
export interface TargetView { x: number; z: number; w: number; d: number; lit: boolean; label: string }

export interface DrillView {
  /** 'practice' free hitting at targets, or 'tutorial' scripted lessons. */
  kind: 'practice' | 'tutorial';
  title: string;
  /** What to do now, one short line. */
  hint: string;
  targets: TargetView[];
  /** Station progress: done of need (tutorial), or balls used of the basket (practice). */
  done: number;
  need: number;
  /** Station index and count. */
  station: number;
  stations: number;
  score: number;
  streak: number;
  bestStreak: number;
  /** Result of the last ball, for a short call: null until one is played. */
  last: 'target' | 'in' | 'out' | 'net' | 'missed' | 'fault' | null;
}

/**
 * Where the ball met the racket face (DESIGN.md section 5): `a` along the racket,
 * -1 throat to +1 tip; `b` across it, -1 bottom edge to +1 top edge. The string
 * bed is a^2 + b^2 <= 1; `frame` is true for a frame hit (1 < r <= 1.25).
 */
export interface ContactPoint { a: number; b: number; frame: boolean }

export type MatchEvent =
  | { type: 'toss'; player: number }
  /**
   * quality: 0..1 from the distance to the sweet spot (0.05 off the frame).
   * power: the swing's power. u: timing ratio (Ts - T*) / W, negative early
   * (serves: toss timing, -1..1).
   */
  | {
    type: 'hit'; player: number; quality: number; power: number; spin: number; u: number; speedKmh: number;
    contact: ContactPoint;
    /** Match time of the contact, ms, and which stroke it was. */
    t: number; stroke: 'forehand' | 'backhand' | 'serve';
  }
  | { type: 'whiff'; player: number }
  | { type: 'bounce'; pos: Vec3; in: boolean }
  | { type: 'net' }
  | { type: 'fault'; serveNumber: 1 | 2 }
  /** `by`: the player whose last touch decided it (the winner's for 'winner' and 'ace', the loser's otherwise); `rally`: shots played. */
  | { type: 'point'; winner: Side; reason: 'winner' | 'out' | 'net' | 'double-fault' | 'missed' | 'ace'; by: number | null; rally: number }
  /** Drills: a ball's result, and progress through the stations. */
  | { type: 'drill'; result: NonNullable<DrillView['last']>; score: number; stationDone: boolean; finished: boolean }
  | { type: 'game'; winner: Side }
  | { type: 'match'; winner: Side };

export interface Match {
  /** Drills only: give up on the current station and move to the next. */
  skip?(): void;
  /** Advance to host time `now` (ms) and return what happened since the last call. */
  update(now: number): MatchEvent[];
  /**
   * A human swung. Swings outside the acceptance window are ignored, not
   * whiffs; inside it the timing decides where the ball meets the face, and a
   * contact beyond the frame is a whiff (DESIGN.md section 5).
   */
  swing(input: SwingInput): void;
  view(): MatchView;
}
