import type { MatchEvent, MatchView, PlayerView, Vec3 } from '../engine/types';
import type { SwingTrace } from '../shared/trace';

/**
 * The point replay (docs/v2/BRIEF.md pillar 2): a short slow-motion look at
 * the shot that decided a point, with the swing path drawn from the phone's
 * own sensor trace. The host keeps the last seconds of match views; a replay
 * is those same views played again, so it shows exactly what happened.
 * Pure: no DOM, no three.js.
 */

type HitEvent = Extract<MatchEvent, { type: 'hit' }>;
type PointEvent = Extract<MatchEvent, { type: 'point' }>;

export interface ReplayFrame { t: number; view: MatchView }

export interface ReplayClip {
  frames: ReplayFrame[];
  /** Match time the clip covers, ms. */
  from: number;
  to: number;
  /** The shot the clip is about, and who played it. */
  hit: HitEvent;
  /** That swing's sensor trace, when the phone sent one. */
  trace: SwingTrace | null;
  /** Why the point is being shown again. */
  title: string;
}

export const REPLAY = {
  /** Views are kept this long, ms of match time. */
  keepMs: 14_000,
  /** The clip starts this long before the shot and ends this long after it, ms. */
  leadMs: 750,
  tailMs: 1100,
  /** Playback speed (0.4 is two and a half times slower than life). */
  speed: 0.4,
  /** A rally at least this long is replayed whoever won it. */
  longRally: 9,
  /** Points between two replays, so the match keeps moving. Match point ignores it. */
  minGap: 2,
  /** A trace belongs to a hit when their times are this close, ms. */
  traceMatchMs: 160,
};

export class ReplayBuffer {
  private frames: ReplayFrame[] = [];
  private hits: HitEvent[] = [];
  private traces: { player: number; t: number; trace: SwingTrace }[] = [];
  private sinceReplay = Infinity;

  /** Record one frame of the match and what happened in it. `t` is match time. */
  push(t: number, view: MatchView, events: MatchEvent[]): void {
    this.frames.push({ t, view });
    for (const e of events) if (e.type === 'hit') this.hits.push(e);
    const from = t - REPLAY.keepMs;
    while (this.frames.length && this.frames[0].t < from) this.frames.shift();
    while (this.hits.length && this.hits[0].t < from) this.hits.shift();
    while (this.traces.length && this.traces[0].t < from) this.traces.shift();
  }

  /** A phone's trace arrived: `t` is the match time of its swing's peak. */
  addTrace(player: number, t: number, trace: SwingTrace): void {
    this.traces.push({ player, t, trace });
  }

  clear(): void {
    this.frames = [];
    this.hits = [];
    this.traces = [];
    this.sinceReplay = Infinity;
  }

  /**
   * Call once per point. Returns the clip to play, or null when this point is
   * not worth one. `view` is the match view after the point (to know about
   * match point and who is human).
   */
  clipFor(point: PointEvent, view: MatchView): ReplayClip | null {
    this.sinceReplay++;
    const title = replayTitle(point, view);
    const last = view.phase === 'match-over';
    if (!title || (!last && this.sinceReplay <= REPLAY.minGap)) return null;
    // The shot to show: the winner's last touch for a winner or an ace; otherwise the last shot of the side that won the point.
    const winners = view.players.filter((p) => p.side === point.winner).map((p) => p.id);
    const hit = [...this.hits].reverse().find((h) => winners.includes(h.player));
    if (!hit) return null;
    const from = hit.t - REPLAY.leadMs;
    const to = hit.t + REPLAY.tailMs;
    const frames = this.frames.filter((f) => f.t >= from && f.t <= to);
    if (frames.length < 8 || frames[0].t > hit.t) return null;
    const trace = this.traces
      .filter((x) => x.player === hit.player && Math.abs(x.t - hit.t) <= REPLAY.traceMatchMs)
      .sort((a, b) => Math.abs(a.t - hit.t) - Math.abs(b.t - hit.t))[0]?.trace ?? null;
    this.sinceReplay = 0;
    return { frames, from: frames[0].t, to: frames[frames.length - 1].t, hit, trace, title };
  }
}

/** The line shown over a replay, or null when the point does not earn one. */
export function replayTitle(point: PointEvent, view: MatchView): string | null {
  const by = point.by === null ? null : view.players[point.by];
  const human = (p: PlayerView | null | undefined) => !!p && p.human;
  if (view.phase === 'match-over') return 'Match point';
  if (point.reason === 'ace' && human(by)) return 'Ace';
  if (point.reason === 'winner' && human(by)) return 'Winner';
  if (point.rally >= REPLAY.longRally) return `${point.rally}-shot rally`;
  return null;
}

/** How long a clip takes to play, ms of real time. */
export const replayDuration = (clip: ReplayClip) => (clip.to - clip.from) / REPLAY.speed;

const mix = (a: Vec3, b: Vec3, k: number): Vec3 => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k });

/**
 * The view to draw `elapsed` ms of real time into a clip: positions are
 * blended between the two recorded frames around that moment, everything else
 * comes from the earlier one. Also returns the match time shown.
 */
export function replayView(clip: ReplayClip, elapsed: number): { view: MatchView; t: number; done: boolean } {
  const t = clip.from + Math.max(0, elapsed) * REPLAY.speed;
  const frames = clip.frames;
  if (t >= clip.to) return { view: frames[frames.length - 1].view, t: clip.to, done: true };
  let i = 0;
  while (i < frames.length - 2 && frames[i + 1].t <= t) i++;
  const a = frames[i], b = frames[i + 1];
  const k = b.t === a.t ? 0 : Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  // A new ball (any hit between the two frames) is not blended into: the ball would cut the corner.
  const sameFlight = b.view.rally === a.view.rally && b.view.ball.bounces >= a.view.ball.bounces
    && !(a.t < clip.hit.t && b.t >= clip.hit.t);
  const view: MatchView = {
    ...a.view,
    ball: sameFlight ? { ...a.view.ball, pos: mix(a.view.ball.pos, b.view.ball.pos, k) } : a.view.ball,
    players: a.view.players.map((p, j) => ({ ...p, pos: mix(p.pos, b.view.players[j]?.pos ?? p.pos, k) })),
    // The replay is a picture of the past: no score change or message from the frames it replays.
    message: null,
  };
  return { view, t, done: false };
}
