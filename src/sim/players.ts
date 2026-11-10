import { gauss, type Rng } from '../engine/rng';
import type { BallContext, Bot, BotSwing } from './runner';
import type { BankEntry, SwingKind } from './swings';

/**
 * Simulated people (docs/v2/PLAN.md M2): how well they time a swing, what
 * they try to do with the ball, how their phone reads the swing and how late
 * the message arrives. A simulated player swings a synthetic phone swing
 * taken from the bank (swings.ts), so its power, spin and detected peak are
 * what the real detector made of a real-shaped swing.
 *
 * The timing numbers are ASSUMPTIONS, not measurements of Gustav: nobody
 * could be recorded playing. They follow the usual finding for hitting a
 * moving ball on time: practised players are consistent to a few tens of
 * milliseconds, beginners to roughly a tenth of a second and tend to be late.
 * They are meant to span the range of a household, and every report says
 * which skill it used.
 */
export interface Skill {
  name: string;
  /** Timing error against the ideal contact: normal, sd in ms, around a bias (positive is late). */
  timingSd: number;
  timingBias: number;
  /** Chance per ball of a lapse: the swing comes about a quarter of a second late, or not at all. */
  lapse: number;
  /** How often the player tries to place the ball (swinging early or late on purpose), 0 to 1. */
  aim: number;
  /** How far from the ideal contact an aimed swing is meant to be, as a share of the timing window W (0.5 is half-way to the edge of the strings). */
  aimU: number;
  /** Share of swings meant as topspin, flat and slice. */
  spinMix: Record<SwingKind, number>;
  /** Serve: timing sd around the top of the toss, ms. */
  serveSd: number;
}

export type SkillName = 'beginner' | 'casual' | 'regular' | 'good' | 'sharp';

export const SKILLS: Record<SkillName, Skill> = {
  beginner: { name: 'Beginner', timingSd: 95, timingBias: 30, lapse: 0.08, aim: 0, aimU: 0, spinMix: { top: 0.2, flat: 0.7, slice: 0.1 }, serveSd: 160 },
  casual: { name: 'Casual', timingSd: 70, timingBias: 15, lapse: 0.04, aim: 0.1, aimU: 0.45, spinMix: { top: 0.3, flat: 0.55, slice: 0.15 }, serveSd: 120 },
  regular: { name: 'Regular', timingSd: 50, timingBias: 5, lapse: 0.02, aim: 0.35, aimU: 0.5, spinMix: { top: 0.45, flat: 0.4, slice: 0.15 }, serveSd: 90 },
  good: { name: 'Good', timingSd: 35, timingBias: 0, lapse: 0.01, aim: 0.6, aimU: 0.55, spinMix: { top: 0.5, flat: 0.3, slice: 0.2 }, serveSd: 70 },
  sharp: { name: 'Sharp', timingSd: 22, timingBias: 0, lapse: 0.005, aim: 0.8, aimU: 0.6, spinMix: { top: 0.55, flat: 0.25, slice: 0.2 }, serveSd: 50 },
};

/** Delay between the swing's peak and its message reaching the host, ms. */
export interface Network {
  name: string;
  mean: number;
  sd: number;
  /** Chance of a spike, and its range, ms. */
  spike: number;
  spikeRange: [number, number];
  /** Error of the clock sync (the swing is dated this far off), ms, sd. */
  clockSd: number;
}

export type NetworkName = 'lan' | 'busy' | 'internet';

export const NETWORKS: Record<NetworkName, Network> = {
  /** Phone and laptop on the same quiet Wi-Fi: the design's 5 to 20 ms one way, plus detection. */
  lan: { name: 'Home Wi-Fi', mean: 25, sd: 8, spike: 0.005, spikeRange: [80, 160], clockSd: 3 },
  /** A crowded home network. */
  busy: { name: 'Busy Wi-Fi', mean: 55, sd: 25, spike: 0.03, spikeRange: [120, 300], clockSd: 6 },
  /** Through a relay on the internet. */
  internet: { name: 'Internet relay', mean: 90, sd: 30, spike: 0.03, spikeRange: [180, 400], clockSd: 10 },
};

export type Intent = 'safe' | 'cross' | 'line';

/** What the player meant by a swing: carried on the shot record as its tag. */
export const intentTag = (intent: Intent, kind: SwingKind) => `${intent}:${kind}`;

function pickKind(mix: Record<SwingKind, number>, rng: Rng): SwingKind {
  const r = rng() * (mix.top + mix.flat + mix.slice);
  return r < mix.top ? 'top' : r < mix.top + mix.flat ? 'flat' : 'slice';
}

/**
 * A simulated player with a phone. `bank` is the synthetic swings the real
 * detector has already read (buildBank); a swing the detector missed is a
 * swing the game never hears about. `windowMs` is the timing unit W the player
 * plays with: a player who aims swings early or late by a share of it.
 */
export function phoneBot(skill: Skill, bank: BankEntry[], rng: Rng, network: Network = NETWORKS.lan, windowMs = 130): Bot {
  const aimOffset = skill.aimU * windowMs;
  const pool = new Map<string, BankEntry[]>();
  for (const e of bank) {
    const key = `${e.side}:${e.kind}`;
    pool.set(key, [...(pool.get(key) ?? []), e]);
  }
  const draw = (side: 'fh' | 'bh', kind: SwingKind): BankEntry | null => {
    const list = pool.get(`${side}:${kind}`) ?? pool.get(`${side}:flat`) ?? bank;
    return list.length ? list[Math.floor(rng() * list.length)] : null;
  };
  return {
    swing(ctx: BallContext): BotSwing | null {
      const me = ctx.view.players[ctx.player];
      const kind = pickKind(skill.spinMix, rng);
      if (ctx.kind === 'serve') {
        const entry = draw('fh', kind === 'slice' ? 'flat' : kind);
        if (!entry || !entry.detected) return null;
        return {
          dt: gauss(rng, skill.serveSd) + entry.peakOffset, power: entry.power, spin: entry.spin, omega: entry.omega,
          tag: intentTag('safe', kind),
        };
      }
      // The game picks forehand or backhand from the side the ball is on; the player swings that stroke.
      const side = me.stance === 'backhand' ? 'bh' : 'fh';
      const entry = draw(side, kind);
      if (!entry || !entry.detected) return null;
      const intent: Intent = rng() < skill.aim ? (rng() < 0.5 ? 'cross' : 'line') : 'safe';
      const meant = intent === 'cross' ? -aimOffset : intent === 'line' ? aimOffset : 0;
      let dt = meant + skill.timingBias + gauss(rng, skill.timingSd);
      if (rng() < skill.lapse) {
        if (rng() < 0.3) return null;
        dt += 250;
      }
      // What the host receives: the detector's peak (not the meant one), dated with the clock sync's error.
      dt += entry.peakOffset + gauss(rng, network.clockSd);
      return { dt, power: entry.power, spin: entry.spin, omega: entry.omega, tag: intentTag(intent, kind) };
    },
    tossDelay: () => 300 + rng() * 900,
    lag(): number {
      if (rng() < network.spike) return network.spikeRange[0] + rng() * (network.spikeRange[1] - network.spikeRange[0]);
      return Math.max(4, network.mean + gauss(rng, network.sd));
    },
  };
}
