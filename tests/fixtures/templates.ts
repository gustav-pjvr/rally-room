import { readFileSync } from 'node:fs';
import type { Vector } from '../../src/shared/swing';
import { extractTemplates, type RecordedSample, type SwingTemplate } from '../../src/sim/swings';
import { SESSIONS, labelledSwings, type SplitSet } from './split';

/** A session's raw rows with the gravity estimate the recording kept (columns gx, gy, gz). */
export function loadRecorded(path: string): RecordedSample[] {
  return readFileSync(path, 'utf8').trim().split('\n').slice(1)
    .map((line) => line.split(','))
    .filter((c) => c[0] === 'raw')
    .map((c) => ({
      t: +c[2], accel: [+c[4], +c[5], +c[6]] as Vector, gravity: [+c[7], +c[8], +c[9]] as Vector,
      rot: [+c[10], +c[11], +c[12]] as Vector,
    }));
}

const cache = new Map<string, SwingTemplate[]>();

/** Swing templates cut from the labelled swings of the given sets (docs/v2/FIXTURE-SPLIT.md). */
export function templatesFor(sets: SplitSet[]): SwingTemplate[] {
  const key = sets.join(',');
  const hit = cache.get(key);
  if (hit) return hit;
  const swings = labelledSwings();
  const out: SwingTemplate[] = [];
  SESSIONS.forEach((file, session) => {
    const mine = swings.filter((s) => s.session === session);
    const peaks = mine.map((s, order) => ({ tp: s.tp, side: s.side, kind: s.kind, id: `s${session}-${order}`, session, order, set: s.set }))
      .filter((s) => sets.includes(s.set));
    out.push(...extractTemplates(loadRecorded(file), peaks));
  });
  cache.set(key, out);
  return out;
}
