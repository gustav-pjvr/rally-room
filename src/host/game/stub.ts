/**
 * Dev and test helper: a plausible, endlessly looping rally as a MatchView,
 * so the renderer and UI can be looked at without the rules engine.
 * Pure function of time: stubView(t) is the same for the same t.
 */
import { COURT, type MatchView, type PlayerView, type Vec3 } from '../../engine/types';

const G = 9.81;
const SERVE_AT = 900;
const FLIGHT = 800;
const AFTER = 450;
const SHOTS = 7;
const CYCLE = SERVE_AT + SHOTS * (FLIGHT + AFTER) + 1900;
const CONTACT_Y = 0.9;

interface Shot {
  start: number;
  from: Vec3;
  land: Vec3;
  to: Vec3;
  hitter: 'near' | 'far';
  stroke: 'forehand' | 'backhand' | 'serve';
  out: boolean;
}

const hash = (i: number) => {
  const s = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
  return s - Math.floor(s);
};

const SHOT_LIST: Shot[] = (() => {
  const shots: Shot[] = [];
  let from: Vec3 = { x: 0.8, y: 2.75, z: COURT.halfLength + 0.3 };
  for (let i = 0; i < SHOTS; i++) {
    const hitter = i % 2 === 0 ? 'near' : 'far';
    const dir = hitter === 'near' ? -1 : 1;
    const out = i === SHOTS - 1;
    let land: Vec3;
    if (i === 0) land = { x: -2.1, y: 0, z: -5.2 };
    else if (out) land = { x: 1.6, y: 0, z: dir * (COURT.halfLength + 0.7) };
    else land = { x: (hash(i) * 2 - 1) * 3.2, y: 0, z: dir * (6 + hash(i + 7) * 4.5) };
    const hx = (land.x - from.x) / FLIGHT;
    const hz = (land.z - from.z) / FLIGHT;
    const toZ = land.z + hz * AFTER * 0.85;
    const to: Vec3 = { x: land.x + hx * AFTER * 0.85, y: CONTACT_Y, z: Math.sign(toZ) * Math.min(Math.abs(toZ), COURT.halfLength + 1.2) };
    const stroke = i === 0 ? 'serve' : hash(i + 3) > 0.45 ? 'forehand' : 'backhand';
    shots.push({ start: SERVE_AT + i * (FLIGHT + AFTER), from, land, to, hitter, stroke, out });
    from = to;
  }
  return shots;
})();

/** Ball position along a shot at local time t (ms since the hit). */
function ballOnShot(s: Shot, t: number, out: Vec3, vel: Vec3): number {
  const tb = FLIGHT / 1000;
  const ta = AFTER / 1000;
  if (t < FLIGHT) {
    const u = t / 1000;
    const vy = (s.land.y - s.from.y + (G * tb * tb) / 2) / tb;
    out.x = s.from.x + (s.land.x - s.from.x) * (t / FLIGHT);
    out.z = s.from.z + (s.land.z - s.from.z) * (t / FLIGHT);
    out.y = s.from.y + vy * u - (G * u * u) / 2;
    vel.x = (s.land.x - s.from.x) / tb; vel.z = (s.land.z - s.from.z) / tb; vel.y = vy - G * u;
    return 0;
  }
  const u = (t - FLIGHT) / 1000;
  const vy = (CONTACT_Y + (G * ta * ta) / 2) / ta;
  const k = (t - FLIGHT) / AFTER;
  out.x = s.land.x + (s.to.x - s.land.x) * k;
  out.z = s.land.z + (s.to.z - s.land.z) * k;
  out.y = Math.max(0, vy * u - (G * u * u) / 2);
  vel.x = (s.to.x - s.land.x) / ta; vel.z = (s.to.z - s.land.z) / ta; vel.y = vy - G * u;
  return 1;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Where a side's main player stands at cycle time tc. */
function playerSpot(side: 'near' | 'far', tc: number): { x: number; z: number } {
  const sign = side === 'near' ? 1 : -1;
  const keys: [number, number, number][] = [];
  if (side === 'near') keys.push([0, 0.8 + 0.3, COURT.halfLength + 0.5]);
  else keys.push([0, -1.4, -(COURT.halfLength + 1)]);
  for (let i = 0; i < SHOT_LIST.length; i++) {
    const s = SHOT_LIST[i];
    const next = SHOT_LIST[i + 1];
    if (s.hitter === side) {
      const t = s.start;
      keys.push([t, keys[keys.length - 1][1], keys[keys.length - 1][2]]);
      keys.push([t + 700, s.from.x * 0.3, sign * (COURT.halfLength + 1)]);
    } else if (!s.out) {
      // Receiver: arrive at the contact spot, the ball passing at the stroke side.
      const stroke = next ? next.stroke : 'forehand';
      const right = side === 'near' ? 1 : -1;
      const off = (stroke === 'forehand' ? -0.75 : 0.75) * right;
      const z = Math.min(COURT.halfLength + 1.6, Math.abs(s.to.z) + 0.35) * sign;
      keys.push([s.start + FLIGHT + AFTER - 60, s.to.x + off, z]);
    }
  }
  let prev = keys[0];
  for (const k of keys) {
    if (k[0] >= tc) {
      const span = k[0] - prev[0];
      const a = span > 0 ? smooth(Math.min(1, Math.max(0, (tc - prev[0]) / span))) : 1;
      return { x: prev[1] + (k[1] - prev[1]) * a, z: prev[2] + (k[2] - prev[2]) * a };
    }
    prev = k;
  }
  return { x: prev[1], z: prev[2] };
}

/** A looping singles (or doubles) rally at host time `now` (ms). */
export function stubView(now: number, doubles = false): MatchView {
  const tc = ((now % CYCLE) + CYCLE) % CYCLE;
  const cycleStart = now - tc;
  const pos: Vec3 = { x: 0, y: 0, z: 0 };
  const vel: Vec3 = { x: 0, y: 0, z: 0 };

  let phase: MatchView['phase'] = 'rally';
  let shotIndex = -1;
  for (let i = 0; i < SHOT_LIST.length; i++) if (tc >= SHOT_LIST[i].start) shotIndex = i;
  let bounces = 0;
  let landing: Vec3 | null = null;
  let visible = true;
  let message: string | null = null;

  const serveFrom = SHOT_LIST[0].from;
  if (shotIndex < 0) {
    // Ball in hand, then the toss: up to about 3 m and down to the contact height.
    phase = tc < 300 ? 'serve-wait' : 'toss';
    const u = Math.max(0, tc - 300) / 1000;
    const t = (SERVE_AT - 300) / 1000;
    const vy = (serveFrom.y - 1.1 + (G * t * t) / 2) / t;
    pos.x = serveFrom.x - 0.25; pos.z = serveFrom.z - 0.1;
    pos.y = 1.1 + vy * u - (G * u * u) / 2;
    vel.y = tc < 300 ? 0 : vy - G * u;
  } else {
    const s = SHOT_LIST[shotIndex];
    const local = tc - s.start;
    if (s.out && local > FLIGHT + AFTER) {
      phase = 'point-over';
      message = 'Out';
      const extra = (local - FLIGHT - AFTER) / 1000;
      ballOnShot(s, FLIGHT + AFTER, pos, vel);
      pos.x += vel.x * 0.5 * extra; pos.z += vel.z * 0.5 * extra; pos.y = Math.max(0, 0.9 - extra * 2);
      bounces = 2;
      visible = extra < 1.2;
    } else {
      bounces = ballOnShot(s, local, pos, vel);
      if (bounces === 0) landing = s.land;
      if (s.out && bounces > 0) { phase = 'point-over'; message = 'Out'; }
    }
  }

  const rally = shotIndex + 1;
  const nextShot = SHOT_LIST[shotIndex + 1];
  const players: PlayerView[] = [];
  const mk = (id: number, side: 'near' | 'far', name: string, color: string, human: boolean, x: number, z: number): PlayerView => {
    let lastSwingAt: number | null = null;
    if (id < 2) {
      for (let i = 0; i <= shotIndex; i++) if (SHOT_LIST[i].hitter === side) lastSwingAt = cycleStart + SHOT_LIST[i].start;
    }
    const receiving = id < 2 && phase !== 'point-over' && !!nextShot && nextShot.hitter === side && shotIndex >= 0;
    let stance: PlayerView['stance'] = 'ready';
    if (id === 0 && shotIndex < 0) stance = 'serve';
    else if (id === 0 && shotIndex === 0 && tc - SERVE_AT < 400) stance = 'serve';
    else if (receiving && nextShot) stance = nextShot.stroke === 'serve' ? 'forehand' : nextShot.stroke;
    return { id, side, human, name, color, pos: { x, y: 0, z }, stance, lastSwingAt, receiving };
  };
  const near = playerSpot('near', tc);
  const far = playerSpot('far', tc);
  players.push(mk(0, 'near', 'You', '#E8B04B', true, near.x, near.z));
  players.push(mk(1, 'far', 'CPU', '#F3E9D2', false, far.x, far.z));
  if (doubles) {
    const lean = Math.max(-1.5, Math.min(1.5, pos.x * 0.3));
    players.push(mk(2, 'near', 'Partner', '#8DBFA8', false, -2.4 + lean, 4.2));
    players.push(mk(3, 'far', 'CPU 2', '#6B4E8C', false, 2.4 + lean, -4.2));
  }

  const speedKmh = Math.hypot(vel.x, vel.y, vel.z) * 3.6;
  return {
    phase,
    players,
    ball: { pos, vel, spin: 0.2, visible, bounces, landing },
    score: { points: ['30', '15'], games: [2, 1], sets: [0, 0], server: 'near', tiebreak: false, callout: '' },
    rally,
    serverIndex: 0,
    serveNumber: 1,
    message,
    winner: null,
    stats: { longestRally: 11, fastestShotKmh: Math.max(118, Math.round(speedKmh)) },
  };
}
