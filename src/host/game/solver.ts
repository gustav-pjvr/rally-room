import { accelY, positionAt, vec } from './physics';
import { COURT, type Vec3 } from './types';

/** How far above the net the solver keeps the ball's centre, in metres. */
export const NET_CLEARANCE = 0.15;
/** Each retry raises the flight time by this factor. */
const STEP = 1.05;
const MAX_STEPS = 80;

/** v0 = (L - p0 - a T^2 / 2) / T for the constant acceleration of this spin. */
export function launchVelocity(p0: Vec3, target: Vec3, T: number, spin: number): Vec3 {
  const ay = accelY(spin);
  return vec(
    (target.x - p0.x) / T,
    (target.y - p0.y - 0.5 * ay * T * T) / T,
    (target.z - p0.z) / T,
  );
}

/** Height of the ball's centre where it crosses z = 0, or null if it never crosses. */
export function heightAtNet(p0: Vec3, v0: Vec3, spin: number): number | null {
  if (v0.z === 0 || p0.z === 0 || Math.sign(v0.z) === Math.sign(p0.z)) return null;
  return positionAt({ p0, v0, spin }, -p0.z / v0.z).y;
}

export interface Shot { v0: Vec3; T: number }

/**
 * Shot solver (DESIGN.md section 5): the launch velocity that takes the ball
 * from p0 to target in T seconds. If that would not clear the net by
 * `clearance`, T is raised in 5% steps (a higher, slower arc) until it does.
 */
export function solveShot(p0: Vec3, target: Vec3, T: number, spin: number, clearance = NET_CLEARANCE): Shot {
  let time = Math.max(T, 0.05);
  let v0 = launchVelocity(p0, target, time, spin);
  for (let i = 0; i < MAX_STEPS; i++) {
    const y = heightAtNet(p0, v0, spin);
    if (y === null || y >= COURT.netHeight + clearance) break;
    time *= STEP;
    v0 = launchVelocity(p0, target, time, spin);
  }
  return { v0, T: time };
}
