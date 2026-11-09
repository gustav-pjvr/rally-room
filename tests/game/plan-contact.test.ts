import { describe, expect, it } from 'vitest';
import { HUMAN, planContact, type Mover } from '../../src/host/game/ai';
import { buildPath, vec, type BallPath } from '../../src/host/game/physics';

const ROOM = 0.208; // ACCEPT * W on Normal, s

/** A shot from the far baseline landing short, deep or wide on the near side. */
function shots(): BallPath[] {
  const out: BallPath[] = [];
  for (const vz of [10, 14, 18, 22, 26]) {
    for (const vy of [1, 3, 5]) {
      for (const spin of [-1, 0, 1]) {
        out.push(buildPath({ p0: vec(0.5, 1.2, -11.5), v0: vec(0.4, vy, vz), spin }));
      }
    }
  }
  return out.filter((p) => !p.events.some((e) => e.kind === 'net') && p.events.some((e) => e.index === 2));
}

const mover: Mover = {
  pos: vec(0, 0, 11.5), side: 'near', ...HUMAN, minX: -9, maxX: 9,
};

describe('planContact: a human window must close before the ball dies', () => {
  it('keeps T* at least the acceptance half-width before the second bounce when the ball leaves room', () => {
    let roomy = 0;
    let moved = 0;
    for (const path of shots()) {
      const second = path.events.find((e) => e.index === 2)!.t;
      const first = path.events.find((e) => e.index === 1)!.t;
      const plan = planContact(path, 0, mover, ROOM, ROOM);
      const old = planContact(path, 0, mover, ROOM);
      if (!plan || !old) continue;
      if (second - first >= 2 * ROOM + 0.05) {
        roomy++;
        expect(plan.t).toBeGreaterThanOrEqual(first + ROOM - 1e-9);
        if (plan.t > second - ROOM + 1e-9) {
          // Allowed only when the roomy range had no reachable, comfortable
          // contact; the swing guards then end the window at the second bounce.
          expect(plan.reachable).toBe(true);
          expect(plan.pos.y).toBeGreaterThanOrEqual(0.6 - 1e-9);
          expect(plan.pos.y).toBeLessThanOrEqual(1.3 + 1e-9);
        } else if (old.t > second - ROOM) moved++;
      }
    }
    expect(roomy).toBeGreaterThan(5);
    // The old rule (end = second - 0.03) really did plan contacts the window could not fit around.
    expect(moved).toBeGreaterThan(0);
  });

  it('never makes a ball unreachable or less comfortable than the old plan (all windows, many positions)', () => {
    const comfy = (y: number) => y >= 0.6 - 1e-9 && y <= 1.3 + 1e-9;
    let compared = 0;
    for (const room of [0.288, 0.208, 0.144]) { // ACCEPT * W on Easy, Normal, Pro
      for (const px of [-4, -2, 0, 2, 4]) {
        for (const pz of [9, 11.5, 13]) {
          const m: Mover = { ...mover, pos: vec(px, 0, pz) };
          for (const vx of [-4, -1, 1, 4]) {
            for (const vz of [8, 10, 14, 20]) {
              for (const vy of [1, 3, 5]) {
                for (const spin of [-1, 0, 1]) {
                  const path = buildPath({ p0: vec(0.5, 1.2, -11.5), v0: vec(vx, vy, vz), spin });
                  if (path.events.some((e) => e.kind === 'net')) continue;
                  const plan = planContact(path, 0, m, room, room);
                  const old = planContact(path, 0, m, room);
                  if (!old) continue;
                  compared++;
                  expect(plan).not.toBeNull();
                  if (old.reachable) expect(plan!.reachable, `room ${room} player ${px},${pz} ball ${vx},${vy},${vz},${spin}`).toBe(true);
                  if (old.reachable && comfy(old.pos.y)) expect(comfy(plan!.pos.y)).toBe(true);
                }
              }
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it('falls back to the CPU rule when the ball bounces twice too soon', () => {
    // Low, short-hopping balls bounce again less than 2 * ACCEPT * W after the first bounce: no room for the window.
    let checked = 0;
    for (const y of [0.3, 0.6, 1.0]) {
      for (const vz of [3, 5, 8]) {
        for (const vy of [-3, -1, 0, 1]) {
          for (const spin of [-1, 0, 1]) {
            const path = buildPath({ p0: vec(0.5, y, 6), v0: vec(0.4, vy, vz), spin });
            if (path.events.some((e) => e.kind === 'net')) continue;
            const first = path.events.find((e) => e.index === 1);
            const second = path.events.find((e) => e.index === 2);
            if (!first || !second || second.t - first.t >= 2 * ROOM) continue;
            const roomy = planContact(path, 0, mover, ROOM, ROOM);
            const cpu = planContact(path, 0, mover, ROOM);
            expect(roomy).toEqual(cpu);
            if (roomy) {
              checked++;
              expect(roomy.t).toBeLessThanOrEqual(second.t - 0.03 + 1e-9);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
