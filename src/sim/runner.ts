import type { GameMatch } from '../engine/match';
import type { MatchEvent, MatchView, Vec3 } from '../engine/types';

/**
 * Runs a match or a drill with scripted players (bots) in place of people
 * (docs/v2/PLAN.md M2). Pure and fast: no browser, no clock, thousands of
 * matches per second of real time. The bots act through the same two calls
 * the host makes, update(now) and swing(), with the swing's own time in the
 * past by the network lag, so lag compensation is exercised too.
 */

/** What a bot decided for one ball: a swing `dt` ms from the ideal contact (negative is early). */
export interface BotSwing {
  dt: number;
  power: number;
  spin: number;
  /** Peak rotation rate, deg/s, when the bot models a phone. */
  omega?: number;
  /** What the bot meant by this swing; copied to the shot record. */
  tag?: string;
}

export interface BallContext {
  /** The bot's player index. */
  player: number;
  view: MatchView;
  /** Match time of the ideal contact (T*, or the top of the toss), ms. */
  ideal: number;
  /** 'serve' when the ball is the player's own toss. */
  kind: 'rally' | 'serve';
  /** How many swings this bot has already made at this ball (a whiff may be followed by another try). */
  attempt: number;
}

export interface Bot {
  /** The swing for this ball, or null to let it go. Called once per ball (and once more per retry the bot asks for). */
  swing(ctx: BallContext): BotSwing | null;
  /** Ms between the serve being ready and the toss swing. */
  tossDelay?(ctx: { player: number; view: MatchView }): number;
  /** Network and detection lag for one swing message, ms (0 when absent). */
  lag?(): number;
}

/** One swing a bot made and what came of it. */
export interface ShotRecord {
  player: number;
  kind: 'rally' | 'serve';
  /** Intended timing error, ms, and the resulting timing ratio u when the ball was hit. */
  dt: number;
  u: number | null;
  power: number;
  spin: number;
  outcome: 'hit' | 'whiff' | 'ignored';
  tag: string | null;
  /** How late the swing's message reached the match, ms. */
  lag: number;
  quality: number | null;
  frame: boolean;
  /** Where the ball met the face. */
  a: number | null;
  b: number | null;
  /** Where the struck ball first landed, and whether that was in; null when it hit the net or was struck again first. */
  landing: Vec3 | null;
  landedIn: boolean | null;
  net: boolean;
  /** Court x of the ball at contact (which side of the body it was on decides what early and late mean). */
  ballX: number | null;
}

export interface RunOptions {
  /** Simulated frame length, ms. */
  frameMs?: number;
  /** Stop after this much match time, ms. */
  maxMs?: number;
  /** Match time of the first update. */
  startAt?: number;
}

export interface RunResult {
  events: { t: number; e: MatchEvent }[];
  view: MatchView;
  shots: ShotRecord[];
  /** Match time played, ms. */
  ms: number;
  timedOut: boolean;
}

interface Pending { player: number; at: number; t: number; swing: BotSwing; kind: 'rally' | 'serve'; toss: boolean }

export function runMatch(match: GameMatch, bots: Record<number, Bot>, options: RunOptions = {}): RunResult {
  const frame = options.frameMs ?? 1000 / 60;
  const start = options.startAt ?? 1000;
  const maxMs = options.maxMs ?? 45 * 60_000;
  const events: { t: number; e: MatchEvent }[] = [];
  const shots: ShotRecord[] = [];
  const pending: Pending[] = [];
  /** Per bot: the ball it has already decided on (by its ideal time) and how many tries it used. */
  const decided = new Map<number, { ideal: number; attempts: number }>();
  /** True from the moment a serve is asked for until a bot has planned its toss (set again on every return to serve-wait). */
  let tossDue = true;
  /** The last shot record of each player still waiting for its landing. */
  const flying = new Map<number, ShotRecord>();
  let lastHitter: number | null = null;
  let now = start;
  let view = match.view();

  const note = (list: MatchEvent[]) => {
    for (const e of list) {
      events.push({ t: now, e });
      if (e.type === 'hit') {
        lastHitter = e.player;
        // The most recent undecided swing of this player is the one that struck the ball.
        const rec = [...shots].reverse().find((r) => r.player === e.player && r.outcome === 'ignored' && r.u === null);
        if (rec) {
          rec.outcome = 'hit'; rec.u = e.u; rec.quality = e.quality; rec.frame = e.contact.frame; rec.a = e.contact.a; rec.b = e.contact.b;
          flying.set(e.player, rec);
        }
      } else if (e.type === 'whiff') {
        const rec = [...shots].reverse().find((r) => r.player === e.player && r.outcome === 'ignored');
        if (rec) rec.outcome = 'whiff';
      } else if (e.type === 'bounce' && lastHitter !== null) {
        const rec = flying.get(lastHitter);
        if (rec && rec.landing === null && !rec.net) { rec.landing = { ...e.pos }; rec.landedIn = e.in; flying.delete(lastHitter); }
      } else if (e.type === 'net' && lastHitter !== null) {
        const rec = flying.get(lastHitter);
        if (rec) { rec.net = true; rec.landedIn = false; flying.delete(lastHitter); }
      }
    }
  };

  note(match.update(now));
  view = match.view();
  while (view.phase !== 'match-over' && now - start < maxMs) {
    // Plan: a toss when the serve is ready, a swing for each expected contact.
    for (const key of Object.keys(bots)) {
      const player = Number(key);
      const bot = bots[player];
      if (tossDue && view.phase === 'serve-wait' && view.serverIndex === player && !view.message) {
        tossDue = false;
        const at = now + (bot.tossDelay?.({ player, view }) ?? 250);
        pending.push({ player, at, t: at, swing: { dt: 0, power: 0.6, spin: 0 }, kind: 'serve', toss: true });
      }
      const ideal = match.expectedContact(player);
      if (ideal === null) continue;
      const kind: 'rally' | 'serve' = view.phase === 'toss' ? 'serve' : 'rally';
      const known = decided.get(player);
      const sameBall = known && Math.abs(known.ideal - ideal) < 1;
      if (sameBall) continue;
      decided.set(player, { ideal, attempts: 1 });
      const swing = bot.swing({ player, view, ideal, kind, attempt: 0 });
      if (!swing) continue;
      const t = ideal + swing.dt;
      pending.push({ player, at: Math.max(t, now) + (bot.lag?.() ?? 0), t, swing, kind, toss: false });
    }
    now += frame;
    // Deliver the swings whose message has arrived by now, oldest first.
    pending.sort((a, b) => a.at - b.at);
    while (pending.length && pending[0].at <= now) {
      const p = pending.shift()!;
      if (!p.toss) {
        const ballX = view.ball.pos.x;
        shots.push({
          player: p.player, kind: p.kind, dt: p.swing.dt, u: null, power: p.swing.power, spin: p.swing.spin,
          outcome: 'ignored', tag: p.swing.tag ?? null, lag: Math.max(0, p.at - p.t), quality: null, frame: false, a: null, b: null, landing: null, landedIn: null, net: false, ballX,
        });
      }
      match.swing({ player: p.player, t: Math.min(p.t, now), power: p.swing.power, spin: p.swing.spin, omega: p.swing.omega });
    }
    note(match.update(now));
    const before = view.phase;
    view = match.view();
    if (view.phase === 'serve-wait' && before !== 'serve-wait') tossDue = true;
  }
  return { events, view, shots, ms: now - start, timedOut: view.phase !== 'match-over' };
}

/** A bot that swings `dt()` ms from the ideal contact with fixed power and spin: the scripted human of the v1 tests. */
export function steadyBot(dt: () => number = () => 0, power = 0.6, spin = 0.3): Bot {
  return { swing: () => ({ dt: dt(), power, spin }) };
}
