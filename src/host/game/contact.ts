import { gauss, uniform, type Rng } from './rng';

/**
 * Where the ball meets the racket face, and what that does to the shot
 * (DESIGN.md section 5, "Hitting: the contact point"). Pure: the match feeds it
 * the timing, the swing and the situation, and a seeded random source.
 *
 * Face coordinates: `a` runs along the racket, -1 at the throat (handle end of
 * the string bed) to +1 at the tip; `b` runs across the face, -1 at the bottom
 * edge to +1 at the top edge (the edge facing up at contact). The string bed is
 * the unit disc a^2 + b^2 <= 1; the frame is the ring 1 < r <= FRAME_EDGE.
 */

export const SWEET_SPOT = { a: -0.15, b: 0 } as const;

export const CONTACT = {
  /**
   * a per unit of timing u = (Ts - T*) / W: early (u < 0) reaches toward the
   * tip, late is cramped toward the throat. The sweet spot sits toward the
   * throat, so the early slope is steeper: both bed edges fall near |u| = 1.15,
   * where the old all-or-nothing window ended.
   */
  earlySlope: 1.0,
  lateSlope: 0.75,
  /** b per unit of u * spin: a rising (topspin) racket met early is still low, so the ball sits high on the face. */
  spinB: 0.7,
  /** Placement noise on the face (sd, face units): always, extra when rushed, extra for a stretched or jammed ball. */
  noise: 0.05,
  rushedNoise: 0.12,
  reachNoise: 0.14,
  /** Across the face the noise is this fraction of the noise along it. */
  noiseB: 0.6,
  /** Comfortable contact height, m; outside it the ball moves toward that edge of the face (b per m). */
  comfortLow: 0.5,
  comfortHigh: 1.4,
  lowB: 0.9,
  highB: 0.5,
  /** Ball to body sideways distance, m: under `close` is jammed, over `wide` is stretched (fully at `wide + wideSpan`). */
  close: 0.3,
  wide: 0.95,
  wideSpan: 0.85,
  /** Rushed: slack (s) between arriving at the contact point and the ball arriving, below which the player is rushed. */
  rushedSlack: 0.4,
  /** Beyond this radius the racket misses the ball. */
  frameEdge: 1.25,
  /** Power transfer in the bed: 1 - transferLoss * d^2. */
  transferLoss: 0.45,
  /** Random sideways and length error per unit of d, m (sd). */
  sideError: 1.2,
  lengthError: 0.6,
  /** Tip (a > tipFrom): twists the ball wide, up to tipTwist m further toward the sideline it was heading for, at the tip. */
  tipFrom: 0.5,
  tipTwist: 1.5,
  /**
   * Throat (a < throatFrom): dead, losing up to throatLoss of the power and
   * throatShort m of length at the throat, and sagging up to throatSag radians
   * lower (net risk).
   */
  throatFrom: -0.6,
  throatLoss: 0.45,
  throatShort: 3.5,
  throatSag: (3 * Math.PI) / 180,
  /** Edges across the face: |b| over edgeFrom tilts the launch, up to edgeTilt radians at the edge (top lower, bottom higher). */
  edgeFrom: 0.4,
  edgeTilt: (6 * Math.PI) / 180,
  /** A flat (|spin| < flatSpin) swing over lengthFrom power can still sail: length sd up to lengthRisk m at full power. */
  lengthFrom: 0.9,
  flatSpin: 0.2,
  lengthRisk: 1.8,
  /** Frame hits: their quality, and the share that goes into the net. */
  frameQuality: 0.05,
  frameNet: 0.4,
} as const;

/** Serves: a from the toss timing, b from how far the ball had dropped below the top of the toss. */
export const SERVE_CONTACT = {
  /** b per metre below the top of the toss (the ball is low on the face). */
  dropB: 0.6,
  /** The drop counted is capped here, m (below SERVE_MIN_HEIGHT the serve goes into the net anyway). */
  maxDrop: 1.1,
} as const;

export type ContactKind = 'bed' | 'frame' | 'miss';

export interface Contact {
  a: number;
  b: number;
  /** Distance from the face centre, face units: the string bed is r <= 1. */
  r: number;
  /** 0 at the sweet spot, 1 at the rim, measured along the line from the sweet spot (1 off the bed). */
  d: number;
  kind: ContactKind;
  /** clamp(1 - d) in the bed, CONTACT.frameQuality on the frame, 0 for a miss. */
  quality: number;
}

export interface ContactInput {
  /** Timing ratio (Ts - T*) / W, negative early. */
  u: number;
  /** Swing spin, -1 (high to low) .. +1 (low to high). */
  spin: number;
  /** Ball height at contact, m. */
  height: number;
  /** 0 (had time to set up) .. 1 (arrived at the last moment or not at all). */
  rushed: number;
  /** Sideways distance from the body to the ball at contact, m. */
  lateral: number;
  /** Extra placement noise (sd, face units): the CPU level's own error. */
  extraNoise?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** How far from the sweet spot to the rim a face point is: 0 at the sweet spot, 1 on the rim. */
export function sweetDistance(a: number, b: number): number {
  const da = a - SWEET_SPOT.a;
  const db = b - SWEET_SPOT.b;
  const len = Math.hypot(da, db);
  if (len < 1e-9) return 0;
  const ua = da / len;
  const ub = db / len;
  // Distance from the sweet spot to the unit circle along (ua, ub).
  const proj = SWEET_SPOT.a * ua + SWEET_SPOT.b * ub;
  const s2 = SWEET_SPOT.a ** 2 + SWEET_SPOT.b ** 2;
  const toRim = -proj + Math.sqrt(proj * proj - s2 + 1);
  return len / toRim;
}

/** Bed, frame or miss for a face point. */
export function classify(a: number, b: number): Contact {
  const r = Math.hypot(a, b);
  if (r > CONTACT.frameEdge) return { a, b, r, d: 1, kind: 'miss', quality: 0 };
  if (r > 1) return { a, b, r, d: 1, kind: 'frame', quality: CONTACT.frameQuality };
  const d = Math.min(1, sweetDistance(a, b));
  return { a, b, r, d, kind: 'bed', quality: clamp(1 - d, 0, 1) };
}

/** 0 for a comfortable sideways distance, up to 1 for a ball at full stretch or jammed into the body. */
export function reachAwkwardness(lateral: number): number {
  const C = CONTACT;
  const stretched = clamp((lateral - C.wide) / C.wideSpan, 0, 1);
  const jammed = clamp((C.close - lateral) / C.close, 0, 1);
  return Math.max(stretched, jammed);
}

/** Pushes b toward the edge on the side of an awkward contact height. */
export function heightPush(height: number): number {
  const C = CONTACT;
  if (height < C.comfortLow) return -(C.comfortLow - height) * C.lowB;
  if (height > C.comfortHigh) return (height - C.comfortHigh) * C.highB;
  return 0;
}

/** 0 when the player arrived with time to spare, 1 when there was none (slack in seconds). */
export function rushedFrom(slack: number, reachable: boolean): number {
  if (!reachable) return 1;
  return clamp(1 - slack / CONTACT.rushedSlack, 0, 1);
}

/** Placement noise sd along the racket (face units). */
export function placementSd(input: Pick<ContactInput, 'rushed' | 'lateral' | 'extraNoise'>): number {
  const C = CONTACT;
  const own = C.noise + C.rushedNoise * clamp(input.rushed, 0, 1) + C.reachNoise * reachAwkwardness(input.lateral);
  return Math.hypot(own, input.extraNoise ?? 0);
}

/** a before noise: the sweet spot at perfect timing, toward the tip early and the throat late. */
export function alongFromTiming(u: number): number {
  return SWEET_SPOT.a - u * (u < 0 ? CONTACT.earlySlope : CONTACT.lateSlope);
}

/** Where a rally swing meets the ball. */
export function locateContact(input: ContactInput, rng: Rng): Contact {
  const C = CONTACT;
  const sd = placementSd(input);
  const a = alongFromTiming(input.u) + gauss(rng, sd);
  const b = -C.spinB * input.u * input.spin + heightPush(input.height) + gauss(rng, sd * C.noiseB);
  return classify(a, b);
}

/** Where a serve meets the ball: `u` is the toss timing ratio, `drop` how far below the top of the toss (m). */
export function locateServeContact(u: number, drop: number, extraNoise: number, rng: Rng): Contact {
  const sd = Math.hypot(CONTACT.noise, extraNoise);
  const a = alongFromTiming(u) + gauss(rng, sd);
  const b = -SERVE_CONTACT.dropB * clamp(drop, 0, SERVE_CONTACT.maxDrop) + gauss(rng, sd * CONTACT.noiseB);
  return classify(a, b);
}

export interface StrikeEffect {
  /** Multiplies the swing's power (pace and depth). */
  transfer: number;
  /** Sideways error, m, in court x. */
  dx: number;
  /** Length error, m (positive is longer). */
  ddepth: number;
  /** Launch angle change, radians (positive is higher). */
  tilt: number;
}

/**
 * What an in-bed contact does to the shot. `wide` is the court-x sign of the
 * sideline the shot is heading for (its aim; for a ball aimed down the middle,
 * the outside of the hitting side): a tip hit twists the ball further that way.
 */
export function strikeEffect(c: Contact, wide: number, power: number, spin: number, rng: Rng): StrikeEffect {
  const C = CONTACT;
  let transfer = 1 - C.transferLoss * c.d * c.d;
  let dx = gauss(rng, C.sideError * c.d);
  let ddepth = gauss(rng, C.lengthError * c.d);
  let tilt = 0;
  if (c.a > C.tipFrom) {
    const k = clamp((c.a - C.tipFrom) / (1 - C.tipFrom), 0, 1);
    dx += (wide >= 0 ? 1 : -1) * C.tipTwist * k;
  }
  if (c.a < C.throatFrom) {
    const k = clamp((C.throatFrom - c.a) / (1 + C.throatFrom), 0, 1);
    transfer *= 1 - C.throatLoss * k;
    ddepth -= C.throatShort * k;
    tilt -= C.throatSag * k;
  }
  if (c.b > C.edgeFrom) tilt -= C.edgeTilt * clamp((c.b - C.edgeFrom) / (1 - C.edgeFrom), 0, 1);
  else if (c.b < -C.edgeFrom) tilt += C.edgeTilt * clamp((-C.edgeFrom - c.b) / (1 - C.edgeFrom), 0, 1);
  // Even a centred flat swing at full power can sail long.
  if (power > C.lengthFrom && Math.abs(spin) < C.flatSpin) {
    ddepth += gauss(rng, C.lengthRisk * (power - C.lengthFrom) / (1 - C.lengthFrom));
  }
  return { transfer, dx, ddepth, tilt };
}

/** A frame hit: weak, any direction, mostly out or into the net. Depth is past the net, m. */
export function shank(rng: Rng, halfWidth: number) {
  const C = CONTACT;
  const intoNet = rng() < C.frameNet;
  return {
    intoNet,
    x: uniform(rng, -1, 1) * (halfWidth + 3.5),
    depth: uniform(rng, 2.5, 15),
    /** Height on the net for a ball into the net, m, and the (slow) time it takes to get there, s. */
    netY: uniform(rng, 0.2, 0.7),
    netFlight: uniform(rng, 0.9, 1.2),
    /** A slow, loopy flight. */
    flight: uniform(rng, 1.5, 2.1),
  };
}

/** Turns a launch velocity up (positive) or down by `angle` radians, keeping its speed and heading. */
export function tiltLaunch(v: { x: number; y: number; z: number }, angle: number) {
  if (angle === 0) return v;
  const h = Math.hypot(v.x, v.z);
  const speed = Math.hypot(h, v.y);
  if (h < 1e-9) return v;
  const e = Math.atan2(v.y, h) + angle;
  const k = (speed * Math.cos(e)) / h;
  return { x: v.x * k, y: speed * Math.sin(e), z: v.z * k };
}
