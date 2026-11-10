import type { MatchEvent, Side } from '../engine/types';
import type { RunResult, ShotRecord } from './runner';

/**
 * Turns simulated matches into the numbers the brief asks for (section 6):
 * rally length, error types, outcome spread, and how often a well-timed swing
 * does what the player meant.
 */

type PointEvent = Extract<MatchEvent, { type: 'point' }>;
type Reason = PointEvent['reason'];

export interface Tally {
  matches: number;
  timedOut: number;
  /** Matches won by the near side. */
  nearWins: number;
  points: number;
  /** Total shots over all points (rally lengths summed). */
  shots: number;
  /** Rally length of every point, for spread. */
  rallies: number[];
  /** Points by how they ended and which side the deciding player was on. */
  ends: Record<Side, Record<Reason, number>>;
  /** Match length, minutes of match time. */
  minutes: number[];
  swings: ShotRecord[];
}

export const newTally = (): Tally => ({
  matches: 0, timedOut: 0, nearWins: 0, points: 0, shots: 0, rallies: [], minutes: [], swings: [],
  ends: {
    near: { winner: 0, out: 0, net: 0, 'double-fault': 0, missed: 0, ace: 0 },
    far: { winner: 0, out: 0, net: 0, 'double-fault': 0, missed: 0, ace: 0 },
  },
});

/** Add one finished run. `players` keeps only these players' swings (default: all). */
export function addRun(tally: Tally, run: RunResult, players?: number[]): void {
  tally.matches++;
  if (run.timedOut) tally.timedOut++;
  if (run.view.winner === 'near') tally.nearWins++;
  tally.minutes.push(run.ms / 60_000);
  for (const { e } of run.events) {
    if (e.type !== 'point') continue;
    tally.points++;
    tally.shots += e.rally;
    tally.rallies.push(e.rally);
    const by = e.by === null ? null : run.view.players[e.by]?.side ?? null;
    if (by) tally.ends[by][e.reason]++;
  }
  for (const s of run.shots) if (!players || players.includes(s.player)) tally.swings.push(s);
}

export const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
export function quantile(v: number[], q: number): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
export const share = (n: number, d: number) => (d ? n / d : 0);
export const percent = (x: number) => `${Math.round(x * 100)}%`;

/** Where on the face a hit landed, as the names the game shows. */
export function contactName(s: ShotRecord): 'sweet' | 'centre' | 'tip' | 'throat' | 'edge' | 'frame' | 'whiff' | 'none' {
  if (s.outcome === 'whiff') return 'whiff';
  if (s.outcome !== 'hit' || s.a === null || s.b === null) return 'none';
  if (s.frame) return 'frame';
  if ((s.quality ?? 0) >= 0.7) return 'sweet';
  if (s.a > 0.5) return 'tip';
  if (s.a < -0.6) return 'throat';
  if (Math.abs(s.b) > 0.4) return 'edge';
  return 'centre';
}

export interface SwingSummary {
  swings: number;
  /** Of all rally swings: hit, whiff, or not counted (outside the window, or the ball was already gone). */
  hit: number; whiff: number; ignored: number;
  /** Of hits: by place on the face. */
  face: Record<string, number>;
  /** Of hits: the ball landed in. */
  landedIn: number;
  /** Mean quality of hits. */
  quality: number;
}

export function summariseSwings(swings: ShotRecord[], kind: 'rally' | 'serve' = 'rally'): SwingSummary {
  const list = swings.filter((s) => s.kind === kind);
  const hits = list.filter((s) => s.outcome === 'hit');
  const face: Record<string, number> = {};
  for (const s of hits) face[contactName(s)] = (face[contactName(s)] ?? 0) + 1;
  for (const k of Object.keys(face)) face[k] = share(face[k], hits.length);
  return {
    swings: list.length,
    hit: share(hits.length, list.length),
    whiff: share(list.filter((s) => s.outcome === 'whiff').length, list.length),
    ignored: share(list.filter((s) => s.outcome === 'ignored').length, list.length),
    face,
    landedIn: share(hits.filter((s) => s.landedIn === true).length, hits.length),
    quality: mean(hits.map((s) => s.quality ?? 0)),
  };
}

export interface IntentSummary {
  /** Aimed swings (cross or line) in total, and those that came within `tolerance` ms of the timing the player meant. */
  aimed: number;
  wellTimed: number;
  /** Of the well-timed ones: struck the ball; landed in on the side the player meant. */
  struck: number;
  asMeant: number;
  /** Of every aimed swing, however it was timed: landed in on the side the player meant. */
  asMeantAll: number;
  /** Unaimed ("safe") swings that landed in. */
  safeIn: number;
}

/**
 * "How often a well-timed swing does what the player meant." A swing tagged
 * `cross:*` is meant to land in the half of the court across from the ball's
 * side, `line:*` in the half on the ball's side. `meant` is the timing offset
 * the player aims for (their aimOffset), `actual` picks the swing's real
 * timing error against it from the record's dt.
 */
export function summariseIntent(swings: ShotRecord[], aimOffset: number, tolerance = 30): IntentSummary {
  const rally = swings.filter((s) => s.kind === 'rally' && s.tag);
  const sideOf = (s: ShotRecord) => (s.tag!.startsWith('cross') ? -1 : s.tag!.startsWith('line') ? 1 : 0);
  const asMeant = (s: ShotRecord) => s.outcome === 'hit' && s.landedIn === true && s.landing !== null && s.ballX !== null
    && Math.sign(s.landing.x) === sideOf(s) * (Math.sign(s.ballX) || 1);
  const aimed = rally.filter((s) => sideOf(s) !== 0);
  const well = aimed.filter((s) => Math.abs(s.dt - sideOf(s) * aimOffset) <= tolerance);
  const safe = rally.filter((s) => sideOf(s) === 0 && s.outcome === 'hit');
  return {
    aimed: aimed.length, wellTimed: well.length,
    struck: share(well.filter((s) => s.outcome === 'hit').length, well.length),
    asMeant: share(well.filter(asMeant).length, well.length),
    asMeantAll: share(aimed.filter(asMeant).length, aimed.length),
    safeIn: share(safe.filter((s) => s.landedIn === true).length, safe.length),
  };
}
