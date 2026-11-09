import { GROUND_Y, pathPosition, vec, type BallPath } from './physics';
import { chance, gauss, uniform, type Rng } from './rng';
import type { Level, Side, Vec3 } from './types';

/**
 * CPU decisions (DESIGN.md section 5) and the contact planner that every
 * player, human or CPU, uses to run to the ball.
 */

export interface LevelTuning {
  /** Running speed, m/s. */
  speed: number;
  /** Seconds after the opponent's hit before the CPU starts to run. */
  reaction: number;
  /** Horizontal distance from the body at which the racket still reaches the ball, m. */
  reach: number;
  /** Standard deviation of the CPU's contact timing, ms. */
  timingSd: number;
  /** Rally flight time range, s (1.6 soft to 0.75 full power for humans). */
  flight: [number, number];
  /** Target depth past the net, m. */
  depth: [number, number];
  /** Sideways aim as a fraction of the half width. */
  aim: [number, number];
  spin: [number, number];
  /** Sideways and length error, m. */
  aimSd: number;
  depthSd: number;
  /** Chance per shot of a botched shot (net, long or wide). */
  mishit: number;
  /** Chance of aiming away from the receiver rather than at random. */
  openCourt: number;
  /** Chance of going for a winner: a faster, sharper shot with the same error. */
  attack: number;
  attackFlight: [number, number];
  attackAim: [number, number];
  /** Serve power and spin for the first and second serve. */
  servePower: [number, number];
  serveSpin: [number, number];
  /** Serve placement error, m, first and second serve. */
  serveSd: [number, number];
}

export const LEVELS: Record<Level, LevelTuning> = {
  rookie: {
    speed: 3.8, reaction: 0.4, reach: 1.5, timingSd: 45,
    flight: [1.3, 1.6], depth: [6, 9], aim: [0, 0.45], spin: [0, 0.3],
    aimSd: 0.6, depthSd: 0.9, mishit: 0.14, openCourt: 0.2,
    attack: 0, attackFlight: [1.1, 1.2], attackAim: [0.5, 0.6],
    servePower: [0.45, 0.3], serveSpin: [0.2, 0.5], serveSd: [0.5, 0.3],
  },
  club: {
    speed: 4.8, reaction: 0.28, reach: 1.6, timingSd: 25,
    flight: [1.0, 1.3], depth: [7, 10], aim: [0.35, 0.7], spin: [0.2, 0.6],
    aimSd: 0.45, depthSd: 0.7, mishit: 0.08, openCourt: 0.6,
    attack: 0.15, attackFlight: [0.7, 0.85], attackAim: [0.8, 0.95],
    servePower: [0.65, 0.45], serveSpin: [0.2, 0.6], serveSd: [0.45, 0.28],
  },
  pro: {
    speed: 5.8, reaction: 0.18, reach: 1.7, timingSd: 12,
    flight: [0.8, 1.05], depth: [8.5, 10.4], aim: [0.55, 0.82], spin: [0.4, 0.9],
    aimSd: 0.35, depthSd: 0.55, mishit: 0.05, openCourt: 0.85,
    attack: 0.3, attackFlight: [0.6, 0.75], attackAim: [0.82, 0.95],
    servePower: [0.85, 0.55], serveSpin: [0.1, 0.6], serveSd: [0.4, 0.22],
  },
};

/**
 * Humans run on their own at 5.5 m/s (DESIGN.md section 5), starting 0.2 s
 * after the opponent's hit like an alert player, so sharp angles can win points.
 */
export const HUMAN = { speed: 5.5, reaction: 0.2, reach: 1.8 };

/** Comfortable contact height range, m. */
export const CONTACT_LOW = 0.6;
export const CONTACT_HIGH = 1.3;
/** Players like to hit from about this far behind the net, m. */
export const PREFERRED_DEPTH = 12.3;
/** The ball passes this far to the side of the body at contact, m. */
export const STAND_OFFSET = 0.55;

export interface Mover {
  pos: Vec3;
  side: Side;
  speed: number;
  /** Seconds before this mover starts running. */
  reaction: number;
  reach: number;
  /** Doubles: the x range this player may stand in. */
  minX: number;
  maxX: number;
}

export interface ContactPlan {
  /** Seconds since the path started. */
  t: number;
  /** Ball position at contact. */
  pos: Vec3;
  /** Where the player wants to stand. */
  stand: Vec3;
  reachable: boolean;
  stance: 'forehand' | 'backhand';
}

/** +1 on the near side (z > 0), -1 on the far side. */
export const sideSign = (side: Side) => (side === 'near' ? 1 : -1);

/** Right-handed: a near player faces -z so their right is +x; a far player's right is -x. */
export function stanceFor(side: Side, playerX: number, ballX: number): 'forehand' | 'backhand' {
  const lateral = (ballX - playerX) * sideSign(side);
  return lateral >= 0 ? 'forehand' : 'backhand';
}

/**
 * Choose where and when to meet a ball after its first bounce: a comfortable
 * height (0.6 to 1.3 m) as close as possible to the preferred depth, among the
 * contacts the player can run to in time. `now` is seconds since the path started.
 * Contact is never planned sooner than `minAfterBounce` seconds after the first
 * bounce: a human's hit window opens W before T*, so humans pass W / 1000 to keep
 * the window from opening before the ball has bounced.
 */
export function planContact(
  path: BallPath, now: number, mover: Mover, minAfterBounce = 0.02,
): ContactPlan | null {
  if (path.events.some((e) => e.kind === 'net')) return null;
  const first = path.events.find((e) => e.kind === 'bounce' && e.index === 1);
  if (!first) return null;
  const second = path.events.find((e) => e.kind === 'bounce' && e.index === 2);
  const s = sideSign(mover.side);
  const end = (second ? second.t : first.t + 3) - 0.03;
  type Candidate = { t: number; pos: Vec3 };
  const comfortable: Candidate[] = [];
  const any: Candidate[] = [];
  for (let t = first.t + minAfterBounce; t <= end; t += 0.01) {
    const pos = pathPosition(path, t);
    if (pos.z * s <= 0.3) continue;
    if (pos.y >= CONTACT_LOW && pos.y <= CONTACT_HIGH) comfortable.push({ t, pos });
    else if (pos.y >= 0.2) any.push({ t, pos });
  }
  let candidates = comfortable;
  if (!candidates.length) {
    if (!any.length) return null;
    const top = any.reduce((a, b) => (b.pos.y > a.pos.y ? b : a));
    candidates = [top];
  }
  const plans = candidates.map((c) => {
    const towards = c.pos.x - mover.pos.x >= 0 ? -1 : 1;
    const standX = Math.max(mover.minX, Math.min(mover.maxX, c.pos.x + towards * STAND_OFFSET));
    const stand = vec(standX, 0, c.pos.z);
    const avail = Math.max(0, c.t - now - mover.reaction);
    const shortfall = Math.max(0, Math.hypot(stand.x - mover.pos.x, stand.z - mover.pos.z) - mover.speed * avail);
    const reachable = shortfall + Math.abs(standX - c.pos.x) <= mover.reach;
    const depthCost = Math.abs(Math.abs(c.pos.z) - PREFERRED_DEPTH);
    return { t: c.t, pos: c.pos, stand, reachable, shortfall, depthCost };
  });
  const ok = plans.filter((p) => p.reachable);
  const best = ok.length
    ? ok.reduce((a, b) => (b.depthCost < a.depthCost ? b : a))
    : plans.reduce((a, b) => (b.shortfall < a.shortfall ? b : a));
  return {
    t: best.t, pos: best.pos, stand: best.stand, reachable: best.reachable,
    stance: stanceFor(mover.side, best.stand.x, best.pos.x),
  };
}

export interface ShotChoice {
  /** Landing target on the court (y at ground contact). */
  target: Vec3;
  flight: number;
  spin: number;
  power: number;
  /** A botched shot aimed into the net: do not let the solver raise the arc. */
  intoNet: boolean;
}

/** Pressure from a fast incoming ball, 0 (under 60 km/h) to 1.5 (120 km/h and up). */
export const pressureFrom = (incomingKmh: number) => Math.max(0, Math.min(1.5, (incomingKmh - 60) / 40));

/**
 * A CPU rally shot: aim with the level's range, away from the receiver when
 * the level reads the court, sometimes go for a winner, then add the level's
 * error. Pressure (a fast incoming ball) makes a botched shot more likely.
 */
export function cpuShot(
  level: Level, rng: Rng, hitter: Side, halfWidth: number, receiverX: number | null, pressure = 0,
): ShotChoice {
  const L = LEVELS[level];
  const toward = -sideSign(hitter);
  const attack = chance(rng, L.attack);
  const flightRange = attack ? L.attackFlight : L.flight;
  const aimRange = attack ? L.attackAim : L.aim;
  const flight = uniform(rng, flightRange[0], flightRange[1]);
  const spin = uniform(rng, L.spin[0], L.spin[1]);
  const power = Math.max(0, Math.min(1, (1.6 - flight) / 0.85));
  const sign = receiverX !== null && Math.abs(receiverX) > 0.3 && (attack || chance(rng, L.openCourt))
    ? -Math.sign(receiverX) : (rng() < 0.5 ? -1 : 1);
  let x = sign * uniform(rng, aimRange[0], aimRange[1]) * halfWidth + gauss(rng, L.aimSd);
  let depth = uniform(rng, L.depth[0], L.depth[1]) + gauss(rng, L.depthSd);
  if (chance(rng, L.mishit * (1 + pressure))) {
    if (rng() < 0.4) {
      // Into the net: aim at the tape's lower half.
      return { target: vec(x * 0.5, uniform(rng, 0.3, 0.7), 0), flight: 0.5, spin, power, intoNet: true };
    }
    x += gauss(rng, 2.2);
    depth += 1.5 + Math.abs(gauss(rng, 1.5));
  }
  return { target: vec(x, GROUND_Y, toward * depth), flight, spin, power, intoNet: false };
}

/** CPU serve: timing (wide or T), power, spin and placement error for serve 1 or 2. */
export function cpuServe(level: Level, rng: Rng, serveNumber: 1 | 2) {
  const L = LEVELS[level];
  const i = serveNumber - 1;
  return {
    u: Math.max(-1, Math.min(1, gauss(rng, 0.45))),
    power: L.servePower[i],
    spin: L.serveSpin[i],
    sd: L.serveSd[i],
  };
}

/** CPU contact timing error, ms. */
export const cpuTimingNoise = (level: Level, rng: Rng) => gauss(rng, LEVELS[level].timingSd);
