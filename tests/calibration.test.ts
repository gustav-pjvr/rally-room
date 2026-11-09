import { describe, expect, it } from 'vitest';
import {
  STEPS, SWINGS_PER_STEP, Teacher, asCalibration, fit, fixedSpin, handSide, isCalibrated, playerKey, sideOf, spinFrom,
  type Calibration, type Kind, type LabelledSwing, type Side, type SideCalibration,
} from '../src/shared/calibration';
import { SwingDetector } from '../src/shared/swing';
import { SIDE, loadLabelled } from './fixtures/phones';

const word = (spin: number): Kind => (spin > 0.2 ? 'top' : spin < -0.2 ? 'slice' : 'flat');
const NOW = new Date('2026-11-09T12:00:00Z');

/** Two well separated clusters per kind on one side; path rises slice to top, face falls. */
function synthetic(side: Side, n = 3): LabelledSwing[] {
  const centre: Record<Kind, [number, number]> = { slice: [-0.4, 0.5], flat: [0, 0.1], top: [0.4, -0.3] };
  const out: LabelledSwing[] = [];
  for (const kind of ['slice', 'flat', 'top'] as Kind[]) {
    for (let i = 0; i < n; i++) {
      const e = (i - (n - 1) / 2) * 0.05;
      out.push({ side, kind, path: centre[kind][0] + e, face: centre[kind][1] - e });
    }
  }
  return out;
}

describe('fit', () => {
  it('finds the class means and a pooled spread per side', () => {
    const cal = fit([...synthetic('fh'), ...synthetic('bh')], NOW);
    expect(cal.v).toBe(1);
    expect(cal.at).toBe(NOW.toISOString());
    expect(cal.fh!.flat[0]).toBeCloseTo(0);
    expect(cal.fh!.top).toEqual([expect.closeTo(0.4), expect.closeTo(-0.3)]);
    expect(cal.fh!.sd[0]).toBeCloseTo(Math.sqrt((3 * 2 * 0.05 ** 2) / 6));
    expect(isCalibrated(cal)).toBe(true);
  });

  it('leaves a side on the fixed rule without two swings of every kind', () => {
    const cal = fit([...synthetic('fh'), ...synthetic('bh').filter((s) => !(s.kind === 'top' && s.path > 0.4))], NOW);
    expect(cal.fh).not.toBeNull();
    expect(cal.bh).not.toBeNull();
    const short = fit([...synthetic('fh'), ...synthetic('bh').filter((s) => s.kind !== 'flat' || s.path < -0.01)], NOW);
    expect(short.bh).toBeNull();
    expect(fit([], NOW)).toMatchObject({ fh: null, bh: null });
    expect(isCalibrated(fit([], NOW))).toBe(false);
  });

  it('rejects degenerate input: zero spread, identical means, NaN', () => {
    const same = (kind: Kind) => [1, 2].map(() => ({ side: 'fh' as Side, kind, path: 0.1, face: 0.2 }));
    expect(fit([...same('slice'), ...same('flat'), ...same('top')]).fh).toBeNull();
    // Spread present, but flat lies on the topspin mean.
    const s = synthetic('fh').map((x) => (x.kind === 'top' ? { ...x, path: x.path - 0.4, face: x.face + 0.4 } : x));
    expect(fit(s).fh).toBeNull();
    // NaN samples are dropped; what is left is too few.
    const nan = synthetic('fh', 2).map((x) => (x.kind === 'slice' ? { ...x, path: NaN } : x));
    expect(fit(nan).fh).toBeNull();
  });
});

describe('spinFrom', () => {
  const cal = fit([...synthetic('fh'), ...synthetic('bh')], NOW);
  const fh = cal.fh!;
  const mid = (a: [number, number], b: [number, number]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;

  it('maps the flat mean to 0, the midpoints to +-0.2 and the class means to +-0.6', () => {
    expect(spinFrom(cal, 'fh', ...fh.flat)).toBeCloseTo(0);
    expect(spinFrom(cal, 'fh', ...mid(fh.flat, fh.top))).toBeCloseTo(0.2);
    expect(spinFrom(cal, 'fh', ...mid(fh.flat, fh.slice))).toBeCloseTo(-0.2);
    expect(spinFrom(cal, 'fh', ...fh.top)).toBeCloseTo(0.6);
    expect(spinFrom(cal, 'fh', ...fh.slice)).toBeCloseTo(-0.6);
  });

  it('goes on in a straight line past the class means and clamps to +-1', () => {
    const beyond = (end: [number, number], k: number) => [fh.flat[0] + k * (end[0] - fh.flat[0]), fh.flat[1] + k * (end[1] - fh.flat[1])] as const;
    expect(spinFrom(cal, 'fh', ...beyond(fh.top, 1.25))).toBeCloseTo(0.8);
    expect(spinFrom(cal, 'fh', ...beyond(fh.top, 5))).toBe(1);
    expect(spinFrom(cal, 'fh', ...beyond(fh.slice, 5))).toBe(-1);
  });

  it('is continuous along the line and agrees with the word bands', () => {
    let last = spinFrom(cal, 'fh', ...fh.slice);
    for (let k = -1; k <= 1.0001; k += 0.01) {
      const end = k < 0 ? fh.slice : fh.top, a = Math.abs(k);
      const spin = spinFrom(cal, 'fh', fh.flat[0] + a * (end[0] - fh.flat[0]), fh.flat[1] + a * (end[1] - fh.flat[1]));
      expect(Math.abs(spin - last)).toBeLessThan(0.02);
      last = spin;
    }
  });

  it('falls back to the fixed rule when a side is missing or broken', () => {
    expect(spinFrom(null, 'fh', 0.3, 0)).toBeCloseTo(fixedSpin(0.3));
    expect(spinFrom(cal, null, 0.3, 0)).toBeCloseTo(fixedSpin(0.3));
    expect(spinFrom({ ...cal, bh: null }, 'bh', 0.3, 0)).toBeCloseTo(fixedSpin(0.3));
    expect(spinFrom(cal, 'fh', NaN, 0, 0.42)).toBe(0.42);
    const broken: Calibration = { ...cal, fh: { ...fh, sd: [0, 0] } };
    expect(spinFrom(broken, 'fh', 0.3, 0, 0.11)).toBe(0.11);
    const same: Calibration = { ...cal, fh: { ...fh, top: fh.flat } };
    expect(spinFrom(same, 'fh', 0.3, 0, 0.12)).toBe(0.12);
    expect(fixedSpin(NaN)).toBe(0);
    expect(fixedSpin(0.05)).toBeCloseTo(0);
    expect(fixedSpin(0.22)).toBeCloseTo(0.2);
  });
});

describe('spinFrom reads nearest class mean when the arms differ', () => {
  const make = (flat: [number, number], top: [number, number], slice: [number, number]): Calibration => ({
    v: 1, at: NOW.toISOString(), bh: null, fh: { flat, top, slice, sd: [1, 1] } as SideCalibration,
  });
  const d2 = (a: [number, number], b: [number, number]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

  it('unequal and acute arms: a point nearer the slice mean reads as slice', () => {
    const cal = make([0, 0], [1, 0], [0, 3]);
    // Nearer the slice mean (2.4) than the topspin mean (2.6), although it is further along the topspin arm.
    expect(word(spinFrom(cal, 'fh', 0.55, 1.55))).toBe('slice');
    expect(spinFrom(cal, 'fh', 0.55, 1.55)).toBeLessThan(-0.2);
    expect(spinFrom(cal, 'fh', 1, 0)).toBeCloseTo(0.6);
    expect(spinFrom(cal, 'fh', 0, 3)).toBeCloseTo(-0.6);
    expect(spinFrom(cal, 'fh', 0, 0)).toBeCloseTo(0);
  });

  it('a collinear fit (flat 0, topspin 1, slice 2) reads each class mean as its own sign', () => {
    const cal = make([0, 0], [1, 0], [2, 0]);
    expect(spinFrom(cal, 'fh', 2, 0)).toBeCloseTo(-0.6);
    expect(spinFrom(cal, 'fh', 1, 0)).toBeCloseTo(0.6);
    expect(spinFrom(cal, 'fh', 0, 0)).toBeCloseTo(0);
  });

  it('every class mean reads its own word, and the sign follows the nearer of the topspin and slice means', () => {
    const cals = [make([0, 0], [1, 0], [0, 3]), make([0, 0], [1, 0], [2, 0]), make([0, 0], [2, 1], [-1, 2]), make([1, 1], [2, 0], [0, 3])];
    for (const cal of cals) {
      const c = cal.fh!;
      expect(word(spinFrom(cal, 'fh', ...c.top))).toBe('top');
      expect(word(spinFrom(cal, 'fh', ...c.slice))).toBe('slice');
      expect(word(spinFrom(cal, 'fh', ...c.flat))).toBe('flat');
      for (let x = -2; x <= 4; x += 0.37) for (let y = -2; y <= 4; y += 0.41) {
        const spin = spinFrom(cal, 'fh', x, y);
        if (spin > 1e-9) expect(d2([x, y], c.top)).toBeLessThanOrEqual(d2([x, y], c.slice));
        if (spin < -1e-9) expect(d2([x, y], c.slice)).toBeLessThan(d2([x, y], c.top));
      }
    }
  });
});

describe('storage helpers', () => {
  it('reads back a saved calibration and rejects anything else', () => {
    const cal = fit([...synthetic('fh'), ...synthetic('bh')], NOW);
    expect(asCalibration(JSON.parse(JSON.stringify(cal)))).toEqual(cal);
    for (const bad of [null, 1, 'x', {}, { v: 2, fh: cal.fh, bh: null, at: '' }, { v: 1, fh: { slice: [0] }, bh: null, at: '' }, { v: 1, fh: null, bh: null, at: '' }]) {
      expect(asCalibration(bad)).toBeNull();
    }
    expect(asCalibration({ ...cal, fh: { ...cal.fh, sd: [0, 1] } })).toMatchObject({ fh: null });
  });

  it('keys a player by trimmed, lower-cased name', () => {
    expect(playerKey('  Gustav ')).toBe('gustav');
    expect(playerKey('Anna  Lee')).toBe('anna lee');
  });
});

describe('Teacher (the phone flow)', () => {
  it('walks six steps of three swings, ignores the other side, and fits', () => {
    const t = new Teacher();
    const pts = synthetic('fh');
    expect(t.current).toEqual(STEPS[0]);
    expect(t.add(-1, 0, 0)).toBe(false); // a follow-through the other way
    for (const step of STEPS) {
      for (let i = 0; i < SWINGS_PER_STEP; i++) {
        const p = pts.find((s) => s.kind === step.kind && pts.indexOf(s) % 3 === i)!;
        expect(t.add(step.side === 'fh' ? 1 : -1, p.path, p.face)).toBe(true);
      }
    }
    expect(t.done).toBe(true);
    expect(t.add(1, 0, 0)).toBe(false);
    const cal = t.result(NOW);
    expect(cal.fh).not.toBeNull();
    expect(cal.bh).not.toBeNull();
  });

  it('redo clears the step in progress, or the last finished step when nothing is counted yet', () => {
    const t = new Teacher();
    t.add(1, 0.1, 0); t.add(1, 0.1, 0);
    t.redo();
    expect([t.step, t.count]).toEqual([0, 0]);
    for (let i = 0; i < 3; i++) t.add(1, 0.1, 0);
    expect([t.step, t.count]).toEqual([1, 0]);
    t.redo();
    expect([t.step, t.count]).toEqual([0, 0]);
  });
});

describe('Teacher for left-handed players (hand maps stroke names to the turn direction)', () => {
  const pts = synthetic('fh');
  const point = (kind: Kind, i: number) => pts.filter((s) => s.kind === kind)[i];
  const walk = (t: Teacher, dirOf: (stroke: Side) => number) => {
    for (const step of STEPS) {
      for (let i = 0; i < SWINGS_PER_STEP; i++) {
        const p = point(step.kind, i);
        expect(t.add(dirOf(step.side), p.path, p.face)).toBe(true);
      }
    }
  };

  it('a left-hander passes step 1 with the swings turning the other way', () => {
    const t = new Teacher(true);
    expect(t.current).toEqual(STEPS[0]);
    expect(t.expectedDir).toBe(-1);
    expect(t.add(1, 0.1, 0)).toBe(false);
    expect(t.add(-1, 0.1, 0)).toBe(true);
    expect(t.count).toBe(1);
  });

  it('a right-hander still expects dir +1 for the forehand', () => {
    const t = new Teacher(false);
    expect(t.expectedDir).toBe(1);
    expect(t.add(-1, 0.1, 0)).toBe(false);
    expect(t.add(1, 0.1, 0)).toBe(true);
  });

  it('walks all six steps for a left-hander and stores the fit under the physical side', () => {
    const left = new Teacher(true);
    walk(left, (stroke) => (stroke === 'fh' ? -1 : 1));
    expect(left.done).toBe(true);
    const cal = left.result(NOW);
    expect(cal.fh).not.toBeNull();
    expect(cal.bh).not.toBeNull();
    // At play time spinFrom gets sideOf(dir), the physical side the fit was stored under.
    for (const dir of [-1, 1]) {
      const c = cal[sideOf(dir)!]!;
      expect(spinFrom(cal, sideOf(dir), ...c.top)).toBeCloseTo(0.6);
      expect(spinFrom(cal, sideOf(dir), ...c.slice)).toBeCloseTo(-0.6);
    }
  });

  it('the forehand steps of a left-hander land on the physical side bh, a right-hander on fh', () => {
    const left = new Teacher(true), right = new Teacher(false);
    // Only the three forehand steps (slice, flat, topspin) are taught.
    for (const kind of ['slice', 'flat', 'top'] as Kind[]) {
      for (let i = 0; i < SWINGS_PER_STEP; i++) {
        const p = point(kind, i);
        left.add(-1, p.path, p.face);
        right.add(1, p.path, p.face);
      }
    }
    expect(left.step).toBe(3);
    expect(right.step).toBe(3);
    const l = left.result(), r = right.result();
    expect(l.bh).not.toBeNull();
    expect(l.fh).toBeNull();
    expect(r.fh).not.toBeNull();
    expect(r.bh).toBeNull();
    expect(l.bh!.top).toEqual(r.fh!.top);
  });

  it('handSide swaps for a left-hander and is its own inverse', () => {
    expect(handSide('fh', false)).toBe('fh');
    expect(handSide('fh', true)).toBe('bh');
    expect(handSide(handSide('bh', true), true)).toBe('bh');
  });
});

describe('Teacher rejects swings without finite spin features (no gyro)', () => {
  it('NaN or infinite path or face never counts', () => {
    const t = new Teacher();
    expect(t.add(1, NaN, NaN)).toBe(false);
    expect(t.add(1, 0.1, NaN)).toBe(false);
    expect(t.add(1, NaN, 0.1)).toBe(false);
    expect(t.add(1, Infinity, 0)).toBe(false);
    expect(t.count).toBe(0);
  });
});

describe('Teacher go-back is one step only', () => {
  const finish = (t: Teacher, dir = 1) => { for (let i = 0; i < SWINGS_PER_STEP; i++) t.add(dir, 0.1 + i * 0.01, 0); };

  it('repeated redo on a fresh step goes back once, then stays', () => {
    const t = new Teacher();
    finish(t); finish(t);
    expect([t.step, t.count]).toEqual([2, 0]);
    expect(t.redoLabel).toBe('Redo the last step');
    expect(t.canRedo).toBe(true);
    t.redo();
    expect(t.step).toBe(1);
    expect(t.redoLabel).toBe('Redo this step');
    expect(t.canRedo).toBe(false);
    t.redo(); t.redo();
    expect(t.step).toBe(1);
    // Step 0 kept its swings: counting step 1 again moves on, and then a go-back is offered again.
    finish(t);
    expect([t.step, t.count]).toEqual([2, 0]);
    expect(t.redoLabel).toBe('Redo the last step');
  });

  it('redo, swing, redo cycles never walk back past the step gone back to', () => {
    const t = new Teacher();
    const samples = () => (t as unknown as { samples: LabelledSwing[] }).samples;
    finish(t); finish(t); // steps 0 and 1 done
    t.redo(); // back to step 1
    for (let cycle = 0; cycle < 3; cycle++) {
      t.add(1, 0.2, 0); // one swing counts on step 1
      t.redo(); // clears step 1 only
      t.redo(); // must not go back to step 0
      expect(t.step).toBe(1);
      expect(samples().filter((s) => s.kind === 'slice')).toHaveLength(3);
    }
  });

  it('repeated taps never wipe earlier steps', () => {
    const t = new Teacher();
    finish(t); finish(t);
    t.redo(); t.redo(); t.redo(); t.redo();
    expect(t.step).toBe(1);
    // Only the last step was cleared; step 0 still holds its three swings.
    const samples = () => (t as unknown as { samples: LabelledSwing[] }).samples;
    expect(samples().filter((s) => s.kind === 'slice')).toHaveLength(3);
    expect(samples().filter((s) => s.kind === 'flat')).toHaveLength(0);
    finish(t);
    expect(t.step).toBe(2);
    expect(samples().filter((s) => s.kind === 'flat')).toHaveLength(3);
  });

  it('once a swing counts after a go-back, "Redo this step" clears just that step', () => {
    const t = new Teacher();
    finish(t); finish(t);
    t.redo();
    expect(t.canRedo).toBe(false);
    t.add(1, 0.2, 0);
    expect(t.count).toBe(1);
    expect(t.canRedo).toBe(true);
    expect(t.redoLabel).toBe('Redo this step');
    t.redo();
    expect([t.step, t.count]).toEqual([1, 0]);
    finish(t);
    expect([t.step, t.count]).toEqual([2, 0]);
    expect(t.redoLabel).toBe('Redo the last step');
  });

  it('nothing to redo on the very first step before a swing', () => {
    const t = new Teacher();
    expect(t.canRedo).toBe(false);
    t.add(1, 0.1, 0);
    expect(t.canRedo).toBe(true);
  });
});

/**
 * The real labelled sessions (Samsung A32, 2026-11-09), replayed in order
 * through one detector as in tests/spin.test.ts. For each session, the first
 * three swings of each kind per side (recording order, matching dir) are the
 * calibration; the rest of that session is scored with the word bands.
 */
const FILES = [
  'tests/fixtures/phone-a32-labelled-2026-11-09.csv',
  'tests/fixtures/phone-a32-forehand-2026-11-09.csv',
  'tests/fixtures/phone-a32-backhand-2026-11-09.csv',
];
interface Real { session: number; side: Side; kind: Kind; path: number; face: number; fixed: number }
const real = (() => {
  const d = new SwingDetector();
  const out: Real[] = [];
  let offset = 0;
  FILES.forEach((file, session) => {
    const rec = loadLabelled(file);
    const t0 = rec[0].t;
    for (const s of rec) {
      const r = d.sample(offset + s.t - t0, s.accel, s.native);
      if (r.swing && SIDE[s.label] === r.swing.dir) {
        const [side, kind] = s.label.split('-') as [Side, Kind];
        out.push({ session, side, kind, path: r.swing.path, face: r.swing.face, fixed: r.swing.spin });
      }
    }
    offset += rec[rec.length - 1].t - t0 + 60_000;
  });
  return out;
})();

function split(session: number) {
  const train: Real[] = [], test: Real[] = [];
  const seen = new Map<string, number>();
  for (const s of real.filter((r) => r.session === session)) {
    const key = `${s.side}-${s.kind}`, n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    (n < 3 ? train : test).push(s);
  }
  return { train, test };
}
const score = (cal: Calibration, swings: Real[]) => swings.filter((s) => word(spinFrom(cal, s.side, s.path, s.face, s.fixed)) === s.kind).length;
const fixedScore = (swings: Real[]) => swings.filter((s) => word(s.fixed) === s.kind).length;
const pct = (a: number, b: number) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 0}%)`;

describe('calibration on the real labelled sessions', () => {
  it('beats the fixed rule on the swings after the calibration, per session and overall', () => {
    let right = 0, fixed = 0, total = 0;
    const lines: string[] = [];
    for (const session of [0, 1, 2]) {
      const { train, test } = split(session);
      const cal = fit(train, NOW);
      const r = score(cal, test), f = fixedScore(test);
      right += r; fixed += f; total += test.length;
      lines.push(`session ${session}: calibrated ${pct(r, test.length)}, fixed rule ${pct(f, test.length)}, sides ${cal.fh ? 'fh' : '-'}${cal.bh ? ' bh' : ' -'}, trained on ${train.length}`);
    }
    lines.push(`overall: calibrated ${pct(right, total)}, fixed rule ${pct(fixed, total)}`);
    console.log(lines.join('\n'));
    expect(total).toBeGreaterThan(60);
    expect(right).toBeGreaterThan(fixed);
  });

  it('reports calibrating on one session and scoring another (no assertion: a player drifts between sessions)', () => {
    const lines: string[] = [];
    let right = 0, fixed = 0, total = 0;
    for (const from of [0, 1, 2]) {
      const cal = fit(split(from).train, NOW);
      for (const to of [0, 1, 2]) {
        if (to === from) continue;
        const swings = split(to).test.filter((s) => cal[s.side]);
        const r = score(cal, swings), f = fixedScore(swings);
        right += r; fixed += f; total += swings.length;
        lines.push(`calibrate on ${from}, score ${to}: calibrated ${pct(r, swings.length)}, fixed rule ${pct(f, swings.length)}`);
      }
    }
    lines.push(`cross-session overall: calibrated ${pct(right, total)}, fixed rule ${pct(fixed, total)}`);
    console.log(lines.join('\n'));
    expect(total).toBeGreaterThan(0);
  });
});
