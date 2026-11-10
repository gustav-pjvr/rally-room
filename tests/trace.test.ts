import { describe, expect, it } from 'vitest';
import {
  TRACE_AFTER_MS, TRACE_BEFORE_MS, TRACE_MAX_SAMPLES, TraceRecorder, isTrace, swingPath, type SwingTrace, type Vec,
} from '../src/shared/trace';
import { templatesFor } from './fixtures/templates';

/** The swing trace and the racket path rebuilt from it (docs/v2/DECISIONS.md D6), on the real recordings. */
const templates = templatesFor(['teach', 'tuning', 'heldout']);

/** Record a template the way the phone page would: every sample in, a mark at the peak, then take. */
function traceOf(samples: { t: number; rot: Vec; gravity: Vec }[], axis: Vec = [0, 1, 0]): SwingTrace | null {
  const rec = new TraceRecorder();
  let out: SwingTrace | null = null;
  let marked = false;
  for (const s of samples) {
    rec.add(s.t, s.rot, s.gravity);
    if (!marked && s.t >= 0) { rec.mark(0, axis); marked = true; }
    out = rec.take(s.t) ?? out;
  }
  return out;
}

describe('trace recorder', () => {
  it('keeps the stretch around the peak as a small, valid message', () => {
    let made = 0;
    for (const t of templates) {
      const trace = traceOf(t.samples);
      if (!trace) continue;
      made++;
      expect(isTrace(trace)).toBe(true);
      expect(trace.t0).toBeGreaterThanOrEqual(-TRACE_BEFORE_MS - 1);
      expect(trace.t0 + (trace.w.length / 3 - 1) * trace.step).toBeLessThanOrEqual(TRACE_AFTER_MS + 20);
      expect(trace.w.length / 3).toBeLessThanOrEqual(TRACE_MAX_SAMPLES);
      expect(JSON.stringify({ t: 'trace', ...trace }).length).toBeLessThan(1500);
    }
    // Templates that end sooner than the stretch after the peak give no trace; nearly all are long enough.
    expect(made).toBeGreaterThan(templates.length * 0.8);
  });

  it('gives nothing until the stretch after the peak has passed, and nothing twice', () => {
    const rec = new TraceRecorder();
    for (let t = 0; t <= 600; t += 16) rec.add(t, [0, 0, 300], [0, 0, 1]);
    rec.mark(500, [0, 1, 0]);
    expect(rec.take(600)).toBeNull();
    for (let t = 616; t <= 760; t += 16) rec.add(t, [0, 0, 300], [0, 0, 1]);
    expect(rec.take(760)).not.toBeNull();
    expect(rec.take(800)).toBeNull();
  });

  it('ignores samples without a gyroscope', () => {
    const rec = new TraceRecorder();
    for (let t = 0; t <= 900; t += 16) rec.add(t, null, [0, 0, 1]);
    rec.mark(500, [0, 1, 0]);
    expect(rec.take(900)).toBeNull();
  });
});

describe('trace validation', () => {
  const good: SwingTrace = { tp: 1000, t0: -300, step: 16.7, up: [0, 0, 100], axis: [0, 100, 0], w: [1, 2, 3, 4, 5, 6] };
  it('accepts a well-formed trace', () => expect(isTrace(good)).toBe(true));
  it.each([
    ['not an object', 5],
    ['missing fields', { tp: 1 }],
    ['a rate that is not a number', { ...good, w: [1, 2, 'x', 4, 5, 6] }],
    ['a non-finite rate', { ...good, w: [1, 2, Number.NaN, 4, 5, 6] }],
    ['an absurd rate', { ...good, w: [1, 2, 99999, 4, 5, 6] }],
    ['a length that is not a multiple of three', { ...good, w: [1, 2, 3, 4, 5, 6, 7] }],
    ['too many samples', { ...good, w: Array.from({ length: (TRACE_MAX_SAMPLES + 1) * 3 }, () => 1) }],
    ['a zero step', { ...good, step: 0 }],
    ['a start after the peak', { ...good, t0: 5 }],
    ['a bad up vector', { ...good, up: [0, 0] }],
  ])('rejects %s', (_name, value) => expect(isTrace(value)).toBe(false));
});

describe('racket path from a trace', () => {
  it('turns a steady spin about one axis into an arc of the right angle', () => {
    // 360 deg/s about the phone's z for half a second, racket along y: the head sweeps 180 degrees.
    const n = 31;
    const trace: SwingTrace = { tp: 0, t0: -250, step: 500 / (n - 1), up: [0, 0, 100], axis: [0, 100, 0], w: Array.from({ length: n }, () => [0, 0, 360]).flat() };
    const { points } = swingPath(trace);
    const first = points[0], last = points[n - 1];
    const cos = first[0] * last[0] + first[1] * last[1] + first[2] * last[2];
    expect(Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI).toBeGreaterThan(165);
    // A flat spin about the vertical: the head stays level.
    for (const p of points) expect(Math.abs(p[1])).toBeLessThan(0.02);
  });

  it('has the head travelling forward at the peak, for forehands and backhands alike', () => {
    for (const t of templates) {
      const trace = traceOf(t.samples);
      if (!trace) continue;
      const { points, peak } = swingPath(trace);
      const a = points[Math.max(0, peak - 1)], b = points[Math.min(points.length - 1, peak + 1)];
      expect(b[2] - a[2], `${t.id} moves toward -z`).toBeLessThan(0);
      expect(Math.abs(b[0] - a[0]), `${t.id} moves straight ahead`).toBeLessThan(1e-6);
      for (const p of points) expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(1, 1);
    }
  });

  it('shows topspin rising through the ball and slice cutting down, on the real swings', () => {
    // Vertical travel of the head across the peak, by label: the picture must agree with the spin the detector reads.
    const rise = (kind: string, side: string) => {
      const list = templates.filter((t) => t.kind === kind && t.side === side).flatMap((t) => {
        const trace = traceOf(t.samples);
        if (!trace) return [];
        const { points, peak } = swingPath(trace);
        return [points[Math.min(points.length - 1, peak + 2)][1] - points[Math.max(0, peak - 2)][1]];
      });
      return list.reduce((a, b) => a + b, 0) / list.length;
    };
    for (const side of ['fh', 'bh']) {
      expect(rise('top', side), `${side}: topspin rises more than slice`).toBeGreaterThan(rise('slice', side));
      expect(rise('top', side), `${side}: topspin rises`).toBeGreaterThan(0);
      expect(rise('slice', side), `${side}: slice falls`).toBeLessThan(0);
    }
  });
});
