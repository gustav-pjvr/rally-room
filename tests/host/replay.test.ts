import { describe, expect, it } from 'vitest';
import { createMatch } from '../../src/engine/match';
import type { MatchEvent, MatchView } from '../../src/engine/types';
import { REPLAY, ReplayBuffer, replayDuration, replayTitle, replayView, type ReplayClip } from '../../src/host/replay';
import type { SwingTrace } from '../../src/shared/trace';

type PointEvent = Extract<MatchEvent, { type: 'point' }>;
const FRAME = 1000 / 60;
const trace: SwingTrace = { tp: 0, t0: -300, step: 16.7, up: [0, 0, 100], axis: [0, 100, 0], w: [1, 2, 3, 4, 5, 6] };

/** Play a real match frame by frame with a human who swings on time, feeding the buffer; stop at the first clip. */
function firstClip(options: { withTrace?: boolean; power?: number } = {}): { clip: ReplayClip; point: PointEvent; view: MatchView } {
  const match = createMatch({ mode: 'singles', humans: 1, level: 'rookie', window: 'normal', length: 'set1', seed: 4 });
  const buffer = new ReplayBuffer();
  const swung = new Set<number>();
  let t = 1000;
  match.update(t);
  for (let i = 0; i < 400_000; i++) {
    const view = match.view();
    if (view.phase === 'serve-wait' && view.serverIndex === 0 && !view.message) match.swing({ player: 0, t, power: 0.6, spin: 0 });
    const ideal = match.expectedContact(0);
    if (ideal !== null && t >= ideal && !swung.has(Math.round(ideal))) {
      swung.add(Math.round(ideal));
      match.swing({ player: 0, t: ideal, power: options.power ?? 0.95, spin: 0.5 });
      if (options.withTrace) buffer.addTrace(0, ideal + 20, trace);
    }
    t += FRAME;
    const events = match.update(t);
    const after = match.view();
    buffer.push(t, after, events);
    const point = events.find((e): e is PointEvent => e.type === 'point');
    if (point) {
      const clip = buffer.clipFor(point, after);
      if (clip) return { clip, point, view: after };
    }
    if (after.phase === 'match-over') break;
  }
  throw new Error('no clip in a whole set');
}

describe('replay titles', () => {
  const view = (phase: MatchView['phase'], humans: boolean[]): MatchView => ({
    phase, players: humans.map((human, id) => ({ id, human, side: id === 0 ? 'near' : 'far' })),
  } as unknown as MatchView);
  const point = (reason: PointEvent['reason'], by: number | null, rally: number): PointEvent => ({ type: 'point', winner: 'near', reason, by, rally });

  it('replays a human winner or ace, a long rally, and match point', () => {
    const v = view('point-over', [true, false]);
    expect(replayTitle(point('winner', 0, 4), v)).toBe('Winner');
    expect(replayTitle(point('ace', 0, 1), v)).toBe('Ace');
    expect(replayTitle(point('out', 1, REPLAY.longRally), v)).toBe(`${REPLAY.longRally}-shot rally`);
    expect(replayTitle(point('out', 1, 2), view('match-over', [true, false]))).toBe('Match point');
  });

  it('does not replay an ordinary error or a CPU winner', () => {
    const v = view('point-over', [true, false]);
    expect(replayTitle(point('out', 1, 3), v)).toBeNull();
    expect(replayTitle(point('net', 0, 5), v)).toBeNull();
    expect(replayTitle(point('winner', 1, 4), v)).toBeNull();
  });
});

describe('replay clips from a real match', () => {
  const { clip, view } = firstClip({ withTrace: true });

  it('covers the deciding shot with time before and after it', () => {
    expect(clip.frames.length).toBeGreaterThan(30);
    expect(clip.from).toBeLessThan(clip.hit.t);
    expect(clip.to).toBeGreaterThan(clip.hit.t);
    expect(clip.hit.t - clip.from).toBeLessThanOrEqual(REPLAY.leadMs + FRAME);
    // The shot shown was played by the side that won the point.
    expect(view.players[clip.hit.player].side).toBe('near');
  });

  it('attaches the trace of that swing, and only a trace close in time', () => {
    expect(clip.trace).toEqual(trace);
    expect(firstClip({ withTrace: false }).clip.trace).toBeNull();
  });

  it('plays in slow motion from start to end', () => {
    const total = replayDuration(clip);
    expect(total).toBeCloseTo((clip.to - clip.from) / REPLAY.speed, 5);
    expect(replayView(clip, 0).t).toBe(clip.from);
    expect(replayView(clip, total / 2).done).toBe(false);
    expect(replayView(clip, total + 1).done).toBe(true);
    // Time only moves forward, at the replay speed.
    let last = -Infinity;
    for (let e = 0; e < total; e += 16) {
      const { t } = replayView(clip, e);
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
  });

  it('moves the ball smoothly between recorded frames and never jumps across a hit', () => {
    let previous = replayView(clip, 0).view.ball.pos;
    let previousRally = replayView(clip, 0).view.rally;
    let biggest = 0;
    for (let e = 4; e < replayDuration(clip); e += 4) {
      const { view: v, t } = replayView(clip, e);
      const step = Math.hypot(v.ball.pos.x - previous.x, v.ball.pos.y - previous.y, v.ball.pos.z - previous.z);
      // At 0.4 speed, 4 ms of playback is 1.6 ms of match time: a 200 km/h ball moves 9 cm. A re-launch at a hit
      // (this shot or the one before it) may jump more, so the frames around a change of rally count are left out.
      const rallyChanged = v.rally !== previousRally;
      if (Math.abs(t - clip.hit.t) > 2 * FRAME && !rallyChanged) biggest = Math.max(biggest, step);
      previous = v.ball.pos;
      previousRally = v.rally;
    }
    expect(biggest).toBeLessThan(0.2);
  });

  it('shows no message from the past', () => {
    expect(replayView(clip, 100).view.message).toBeNull();
  });
});

describe('replay pacing', () => {
  it('leaves at least two points between replays', () => {
    const buffer = new ReplayBuffer();
    const view = { phase: 'point-over', players: [{ id: 0, human: true, side: 'near' }, { id: 1, human: false, side: 'far' }] } as unknown as MatchView;
    const hit = (t: number): MatchEvent => ({
      type: 'hit', player: 0, quality: 1, power: 1, spin: 0, u: 0, speedKmh: 100, contact: { a: 0, b: 0, frame: false }, t, stroke: 'forehand',
    });
    const point: PointEvent = { type: 'point', winner: 'near', reason: 'winner', by: 0, rally: 3 };
    let t = 0;
    const playPoint = () => {
      for (let i = 0; i < 200; i++) { t += FRAME; buffer.push(t, view, i === 100 ? [hit(t)] : []); }
      return buffer.clipFor(point, view);
    };
    expect(playPoint()).not.toBeNull();
    expect(playPoint()).toBeNull();
    expect(playPoint()).toBeNull();
    expect(playPoint()).not.toBeNull();
  });
});
