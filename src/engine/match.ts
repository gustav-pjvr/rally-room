import {
  HUMAN, LEVELS, cpuServe, cpuShot, cpuTimingNoise, planContact, pressureFrom, sideSign, stanceFor,
  type ContactPlan, type LevelTuning, type Mover,
} from './ai';
import { characterOf, cpuTuning } from './personalities';
import {
  GROUND_Y, buildPath, pathPosition, pathSpin, pathVelocity, speedKmh, vec, type BallPath,
} from './physics';
import {
  CONTACT, locateContact, locateServeContact, rushedFrom, shank, strikeEffect, tiltLaunch, type Contact,
} from './contact';
import { createRng, gauss, type Rng } from './rng';
import { awardPoint, createScore, other, scoreView, serveCourt, type ScoreState } from './scoring';
import { launchVelocity, solveShot } from './solver';
import {
  COURT, type BallView, type CpuStyle, type HitWindow, type Match, type MatchConfig, type MatchEvent, type MatchView,
  type Phase, type PlayerStats, type PlayerView, type SeatConfig, type Side, type SwingInput, type Vec3,
} from './types';

/**
 * The match state machine (DESIGN.md section 5): serve-wait, toss, rally,
 * point-over, match-over. All times are host milliseconds; ball paths are
 * analytic, so the ball's history is exact and lag compensation re-launches
 * the ball from where it really was at the swing's time.
 */

/**
 * Timing unit W per setting, ms: u = (Ts - T*) / W. At |u| about 1 the ball
 * meets the edge of the string bed (DESIGN.md section 5).
 */
export const HIT_WINDOW_MS: Record<HitWindow, number> = { easy: 180, normal: 130, pro: 90 };
/** Swings with |Ts - T*| up to ACCEPT * W meet the ball somewhere (bed, frame or a clean miss); later or earlier ones are ignored. */
export const ACCEPT = 1.6;
/** A miss is declared only this long after T* + ACCEPT * W, so late swing messages (up to 300 ms old, types.ts) still count. */
export const MISS_GRACE_MS = 300;
export const POINT_PAUSE_MS = 1600;
export const FAULT_PAUSE_MS = 1000;
/** A CPU server waits this long after the point is ready. */
export const CPU_SERVE_DELAY_MS = 1000;
/** Toss: released at 1.5 m going up at 5.4 m/s, so it peaks near 3 m and is back at 1.5 m after 1.1 s. */
export const TOSS = { releaseY: 1.5, vy: 5.4, hitFromMs: 250, hitUntilMs: 1150 };
const TOSS_APEX_MS = (TOSS.vy / 9.81) * 1000;
const TOSS_APEX_Y = TOSS.releaseY + (TOSS.vy * TOSS.vy) / (2 * 9.81);
/** Serve timing: |u| = 1 this far from the top of the toss, ms. */
export const SERVE_TIMING_MS = 550;
/** A serve struck below this height goes into the net. */
export const SERVE_MIN_HEIGHT = 1.9;
/** Rally shots: flight time 1.6 s (soft) to 0.75 s (full power); depth 5 to 10.5 m past the net. */
export const RALLY = { slowFlight: 1.6, fastFlight: 0.75, shortDepth: 5, longDepth: 10.5 };
/** Serves: flight time and depth past the net by power. */
export const SERVE = { slowFlight: 1.2, fastFlight: 0.6, shortDepth: 4.4, longDepth: 5.7 };
/** A CPU shot that loses power (1 - transfer) loses this much depth (m) and gains this much flight time (s) per unit. */
const CPU_LOSS = { depth: 5, flight: 0.9 };
const LINE = 0.025;
/** Stance shown after a hit, ms, so the swing animation has a side. */
const STANCE_HOLD_MS = 450;

const HUMAN_COLORS = ['#e8743b', '#2a8c8c'];
const CPU_COLORS = ['#f2d7a6', '#24313f', '#5b4a7a'];

export interface MatchOptions {
  /** Who serves the first game. Default: far (the CPU), so a new player starts by returning. */
  firstServer?: Side;
}

/** createMatch's result: the Match contract plus helpers for tests and tools. */
export interface GameMatch extends Match {
  /**
   * Host time (ms) of the ideal swing for this player: T* for an incoming
   * ball, or the top of the toss when serving; null when none is expected.
   */
  expectedContact(player: number): number | null;
}

export interface Player {
  id: number;
  side: Side;
  human: boolean;
  name: string;
  color: string;
  pos: Vec3;
  /** Doubles half: -1 covers x < 0, +1 covers x > 0, 0 in singles. */
  half: -1 | 0 | 1;
  speed: number;
  reaction: number;
  reach: number;
  leftHanded: boolean;
  /** Humans: timing unit W and the acceptance half-width ACCEPT * W, ms. */
  window: number;
  accept: number;
  /** CPUs: the character and the tuning it plays with; null for a human. */
  style: CpuStyle | null;
  cpu: LevelTuning | null;
  /** A ball machine (drills). */
  machine: boolean;
  stats: PlayerStats;
  lastSwingAt: number | null;
  stanceHold: { stance: 'forehand' | 'backhand'; until: number } | null;
}

export interface Ball {
  kind: 'toss' | 'serve' | 'rally';
  path: BallPath;
  /** Host ms when the path starts. */
  t0: number;
  /** Next path event to process. */
  cursor: number;
  hitter: number;
  receiver: number | null;
  plan: ContactPlan | null;
  /** Serves: which side of the centre line the box is on (+1 x > 0). */
  boxSign: number;
  /** The ball this one was struck from (lag compensation and stronger-swing upgrades). */
  source: Ball | null;
  power: number;
  /** Scheduled moments, host ms; null when not pending. */
  cpuHitAt: number | null;
  missAt: number | null;
  tossExpire: number | null;
  /** The receiver starts running at this time (reaction). */
  moveFrom: number;
  /** 0..1: how little time the receiver had to get to the contact point (contact.ts rushedFrom). */
  rushed: number;
  whiffed: boolean;
  /** No longer decides anything (point over, fault). */
  dead: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** The sideline a shot aimed at x is heading for; down the middle, the outside of the side of the body the ball was on. */
const wideSign = (aimX: number, bodySide: number) => (Math.abs(aimX) > 0.3 ? Math.sign(aimX) : Math.sign(bodySide) || 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class RulesMatch implements GameMatch {
  protected readonly rng: Rng;
  protected readonly players: Player[];
  protected readonly labels: [string, string];
  protected score: ScoreState;
  protected phase: Phase = 'serve-wait';
  protected clock = 0;
  protected started = false;
  protected ball: Ball | null = null;
  protected ballHidden = false;
  protected serveNumber: 1 | 2 = 1;
  protected serverIndex = 0;
  protected serveTurns: [number, number];
  protected rally = 0;
  protected message: string | null = null;
  protected winner: Side | null = null;
  protected readyAt: number | null = null;
  /** Host ms from which a swing may start the toss: when serve-wait became ready (swings dated earlier are stale). */
  protected serveReadyAt = -Infinity;
  protected cpuServeAt: number | null = null;
  protected phaseUntil: number | null = null;
  protected stats = { longestRally: 0, fastestShotKmh: 0, points: [0, 0] as [number, number] };
  protected pending: MatchEvent[] = [];

  constructor(protected readonly config: MatchConfig, options: MatchOptions = {}) {
    this.rng = createRng(config.seed ?? Date.now());
    this.players = makePlayers(config);
    this.labels = [sideLabel(this.players, 'near', !config.seats), sideLabel(this.players, 'far', !config.seats)];
    const first = options.firstServer ?? 'far';
    this.score = createScore(config.length, first);
    this.serveTurns = first === 'near' ? [0, -1] : [-1, 0];
    this.serverIndex = this.sidePlayers(first)[0].id;
  }

  update(now: number): MatchEvent[] {
    if (!this.started) {
      this.started = true;
      this.clock = now;
      this.startPoint();
    }
    if (now > this.clock) {
      for (let guard = 0; guard < 1000; guard++) {
        const due = this.nextDue();
        if (!due || due.t > now) break;
        this.advancePlayers(due.t);
        due.run();
      }
      this.advancePlayers(now);
    }
    const out = this.pending;
    this.pending = [];
    return out;
  }

  swing(input: SwingInput): void {
    const p = this.players[input.player];
    if (!p || !p.human || !this.started) return;
    if (!Number.isFinite(input.t) || !Number.isFinite(input.power) || !Number.isFinite(input.spin)) return;
    const swing = { ...input, power: clamp(input.power, 0, 1), spin: clamp(input.spin, -1, 1) };
    p.lastSwingAt = swing.t;
    if (typeof input.omega === 'number' && Number.isFinite(input.omega)) {
      p.stats.fastestSwing = Math.max(p.stats.fastestSwing, input.omega);
    }
    const ball = this.ball;
    if (this.phase === 'serve-wait' && this.serverIndex === p.id) {
      if (swing.t >= this.serveReadyAt) this.toss(p, swing.t);
      return;
    }
    if (this.phase === 'toss' && ball?.kind === 'toss' && this.serverIndex === p.id) {
      const dt = swing.t - ball.t0;
      if (dt >= TOSS.hitFromMs && dt <= TOSS.hitUntilMs) this.serve(ball, swing.t, swing.power, swing.spin, null, null);
      return;
    }
    if (this.phase !== 'rally' || !ball || ball.dead) return;
    // Already served: a stronger swing inside the toss window replaces the serve (if it touches the ball).
    const toss = ball.source;
    if (ball.kind === 'serve' && ball.hitter === p.id && toss?.kind === 'toss' && ball.cursor === 0
      && swing.power > ball.power) {
      const dt = swing.t - toss.t0;
      if (dt >= TOSS.hitFromMs && dt <= TOSS.hitUntilMs) this.serve(toss, swing.t, swing.power, swing.spin, null, ball);
      return;
    }
    // The incoming ball, not yet returned. A whiff leaves it in play: a later swing in the window may still touch it.
    if (ball.receiver === p.id && ball.plan) {
      const tStar = ball.t0 + ball.plan.t * 1000;
      // A swing can never strike the ball before its first bounce, nor once it has bounced twice (dead).
      if (swing.t < this.firstBounceAt(ball) || swing.t >= this.secondBounceAt(ball)) return;
      if (Math.abs(swing.t - tStar) > p.accept || this.clock > tStar + p.accept + MISS_GRACE_MS) return;
      if (ball.plan.reachable) this.humanStrike(ball, p, swing);
      else this.whiff(ball, p);
      return;
    }
    // Already returned: a stronger swing inside the same window replaces the shot (a stronger whiff changes nothing).
    const source = ball.source;
    if (ball.hitter === p.id && source?.plan && source.receiver === p.id && ball.cursor === 0
      && swing.power > ball.power) {
      const tStar = source.t0 + source.plan.t * 1000;
      if (swing.t >= this.firstBounceAt(source) && swing.t < this.secondBounceAt(source) && Math.abs(swing.t - tStar) <= p.accept) {
        this.humanStrike(source, p, swing, true);
      }
    }
  }

  /** Host ms of the ball's first bounce (-Infinity when it has none). */
  protected firstBounceAt(ball: Ball): number {
    const first = ball.path.events.find((e) => e.kind === 'bounce' && e.index === 1);
    return first ? ball.t0 + first.t * 1000 : -Infinity;
  }

  /** Host ms of the ball's second bounce: from then on it is dead and no swing can touch it (Infinity when it has none). */
  protected secondBounceAt(ball: Ball): number {
    const second = ball.path.events.find((e) => e.kind === 'bounce' && e.index === 2);
    return second ? ball.t0 + second.t * 1000 : Infinity;
  }

  expectedContact(player: number): number | null {
    const ball = this.ball;
    if (!ball || ball.dead) return null;
    if (this.phase === 'toss' && ball.kind === 'toss' && this.serverIndex === player) return ball.t0 + TOSS_APEX_MS;
    if (this.phase === 'rally' && ball.receiver === player && ball.plan) return ball.t0 + ball.plan.t * 1000;
    return null;
  }

  view(): MatchView {
    const ball = this.ball;
    const receiver = this.receivingPlayer();
    const players: PlayerView[] = this.players.map((p) => ({
      id: p.id, side: p.side, human: p.human, name: p.name, color: p.color,
      pos: { ...p.pos }, stance: this.stanceOf(p), lastSwingAt: p.lastSwingAt, receiving: receiver === p.id,
      half: p.half, leftHanded: p.leftHanded, style: p.style, machine: p.machine,
    }));
    return {
      phase: this.phase,
      players,
      ball: this.ballView(ball),
      score: scoreView(this.score, this.labels),
      rally: this.rally,
      serverIndex: this.serverIndex,
      serveNumber: this.serveNumber,
      message: this.message,
      winner: this.winner,
      stats: {
        longestRally: this.stats.longestRally, fastestShotKmh: this.stats.fastestShotKmh,
        players: this.players.map((p) => ({ ...p.stats })), points: [this.stats.points[0], this.stats.points[1]],
      },
      labels: [this.labels[0], this.labels[1]],
    };
  }

  // ---- scheduling ----

  protected nextDue(): { t: number; run: () => void } | null {
    const options: { t: number; run: () => void }[] = [];
    const ball = this.ball;
    if (ball) {
      const event = ball.path.events[ball.cursor];
      if (event) options.push({ t: ball.t0 + event.t * 1000, run: () => this.onBallEvent(ball) });
      if (ball.cpuHitAt !== null) options.push({ t: ball.cpuHitAt, run: () => this.onCpuHit(ball) });
      if (ball.missAt !== null) options.push({ t: ball.missAt, run: () => this.onMiss(ball) });
      if (ball.tossExpire !== null) options.push({ t: ball.tossExpire, run: () => this.onTossExpire(ball) });
    }
    if (this.readyAt !== null) options.push({ t: this.readyAt, run: () => this.onReady() });
    if (this.cpuServeAt !== null) options.push({ t: this.cpuServeAt, run: () => this.onCpuServe() });
    if (this.phaseUntil !== null) options.push({ t: this.phaseUntil, run: () => this.onPhaseEnd() });
    if (!options.length) return null;
    return options.reduce((a, b) => (b.t < a.t ? b : a));
  }

  protected emit(event: MatchEvent) {
    this.pending.push(event);
  }

  /** A clean miss by a swing: announced once per ball; the ball stays in play. */
  protected whiff(ball: Ball, p: Player) {
    if (ball.whiffed) return;
    ball.whiffed = true;
    p.stats.whiffs++;
    this.emit({ type: 'whiff', player: p.id });
  }

  // ---- points ----

  protected startPoint() {
    this.phase = 'serve-wait';
    this.serveNumber = 1;
    this.rally = 0;
    this.message = null;
    this.ball = null;
    this.ballHidden = false;
    this.readyAt = null;
    this.serveReadyAt = this.clock;
    this.phaseUntil = null;
    for (const p of this.players) {
      p.pos = this.servePosition(p);
      p.stanceHold = null;
    }
    const server = this.players[this.serverIndex];
    this.cpuServeAt = server.human ? null : this.clock + CPU_SERVE_DELAY_MS;
  }

  protected point(winner: Side, reason: Extract<MatchEvent, { type: 'point' }>['reason']) {
    if (this.phase === 'point-over' || this.phase === 'match-over') return;
    const last = this.ball;
    // Whose last touch decided it: the winner's shot for a winner or an ace, otherwise the player who erred.
    const by = reason === 'double-fault' ? this.serverIndex
      : reason === 'missed' ? last?.receiver ?? null
        : last?.hitter ?? null;
    if (last) this.killBall(last);
    if (by !== null) {
      const st = this.players[by].stats;
      if (reason === 'winner' || reason === 'ace') {
        st.winners++;
        if (reason === 'ace') st.aces++;
      } else {
        st.errors++;
        if (reason === 'double-fault') st.doubleFaults++;
      }
    }
    this.stats.points[winner === 'near' ? 0 : 1]++;
    this.emit({ type: 'point', winner, reason, by, rally: this.rally });
    this.stats.longestRally = Math.max(this.stats.longestRally, this.rally);
    const result = awardPoint(this.score, winner);
    this.score = result.state;
    this.message = REASON_MESSAGE[reason];
    this.cpuServeAt = null;
    this.readyAt = null;
    const label = this.labels[winner === 'near' ? 0 : 1];
    if (result.game) {
      this.emit({ type: 'game', winner });
      this.message = `Game, ${label}`;
    }
    this.syncServer();
    if (result.match) {
      this.emit({ type: 'match', winner });
      this.message = `Match, ${label}`;
      this.winner = winner;
      this.phase = 'match-over';
    } else {
      this.phase = 'point-over';
    }
    this.phaseUntil = this.clock + POINT_PAUSE_MS;
  }

  /** Move the serve to the next player when the scoring hands it to the other side. */
  protected syncServer() {
    const side = this.score.server;
    if (this.players[this.serverIndex].side === side) return;
    const i = side === 'near' ? 0 : 1;
    this.serveTurns[i]++;
    const team = this.sidePlayers(side);
    this.serverIndex = team[this.serveTurns[i] % team.length].id;
  }

  protected onPhaseEnd() {
    this.phaseUntil = null;
    if (this.phase === 'match-over') this.ballHidden = true;
    else if (this.phase === 'point-over') this.startPoint();
  }

  protected onReady() {
    this.readyAt = null;
    this.message = null;
    if (this.phase === 'serve-wait') this.ball = null;
  }

  protected killBall(ball: Ball) {
    ball.dead = true;
    ball.cpuHitAt = null;
    ball.missAt = null;
    ball.tossExpire = null;
  }

  // ---- serving ----

  protected toss(server: Player, t: number) {
    this.readyAt = null;
    this.cpuServeAt = null;
    this.message = null;
    const s = sideSign(server.side);
    const p0 = vec(server.pos.x + 0.25, TOSS.releaseY, server.pos.z - s * 0.45);
    const path = buildPath({ p0, v0: vec(0, TOSS.vy, 0), spin: 0 });
    const ball = this.newBall('toss', path, t, server.id, 0);
    ball.receiver = null;
    if (server.human) ball.tossExpire = t + TOSS.hitUntilMs + MISS_GRACE_MS;
    else {
      const timing = gauss(this.rng, server.cpu!.timingSd);
      ball.cpuHitAt = t + TOSS_APEX_MS + timing;
    }
    this.ball = ball;
    this.phase = 'toss';
    this.emit({ type: 'toss', player: server.id });
  }

  protected onTossExpire(ball: Ball) {
    // An unhit toss is caught and tossed again: no fault.
    ball.tossExpire = null;
    if (this.ball !== ball || this.phase !== 'toss') return;
    this.phase = 'serve-wait';
    this.serveReadyAt = this.clock;
    this.ball = null;
  }

  protected onCpuServe() {
    this.cpuServeAt = null;
    if (this.phase !== 'serve-wait') return;
    this.toss(this.players[this.serverIndex], this.clock);
  }

  /**
   * Strike the serve from the toss at host time t. `cpu` carries the CPU's aim
   * and placement error. `replacing` is a serve this swing replaces (a stronger
   * swing in the toss window); it is only replaced if the new swing touches the
   * ball. A human whiff leaves the toss falling. Returns false on a whiff.
   */
  protected serve(
    toss: Ball, t: number, power: number, spin: number, cpu: { u: number; sd: number } | null, replacing: Ball | null,
  ): boolean {
    const server = this.players[toss.hitter];
    const contact = pathPosition(toss.path, (t - toss.t0) / 1000);
    const timing = (t - (toss.t0 + TOSS_APEX_MS)) / SERVE_TIMING_MS;
    const u = cpu ? cpu.u : clamp(timing, -1, 1);
    const faceSd = cpu ? server.cpu?.faceSd ?? 0 : 0;
    let c = locateServeContact(timing, TOSS_APEX_Y - contact.y, faceSd, this.rng);
    const low = contact.y < SERVE_MIN_HEIGHT;
    if (c.kind === 'miss') {
      if (server.human && !low) {
        if (!replacing) this.whiff(toss, server);
        return false;
      }
      // A CPU never whiffs its serve, and a ball struck too low goes into the net regardless.
      c = { ...c, kind: 'frame', quality: CONTACT.frameQuality };
    }
    if (replacing) this.killBall(replacing);
    toss.tossExpire = null;
    toss.cpuHitAt = null;
    const deuce = serveCourt(this.score) === 'deuce';
    const s = sideSign(server.side);
    const boxSign = -s * (deuce ? 1 : -1);
    // Early (u < 0) goes wide, late (u > 0) goes down the T.
    let x = boxSign * clamp(2.05 - u * 1.6, 0.3, 3.8);
    let v0: Vec3;
    if (low) {
      // Struck too low: no angle to get over, it goes into the net.
      v0 = launchVelocity(contact, vec(x * 0.3, 0.5, 0), 0.45, spin);
    } else if (c.kind === 'frame') {
      v0 = this.shankVelocity(contact, server.side, spin, COURT.singlesHalfWidth);
    } else {
      // A tip hit twists the serve wide, toward the sideline of its box.
      const fx = strikeEffect(c, Math.sign(x) || boxSign, power, spin, this.rng);
      const effective = power * fx.transfer;
      let depth = lerp(SERVE.shortDepth, SERVE.longDepth, effective) + fx.ddepth;
      x += fx.dx;
      if (cpu) {
        x += gauss(this.rng, cpu.sd);
        depth += gauss(this.rng, cpu.sd);
      }
      const flight = lerp(SERVE.slowFlight, SERVE.fastFlight, effective);
      v0 = tiltLaunch(solveShot(contact, vec(x, GROUND_Y, -s * Math.max(1.5, depth)), flight, spin).v0, fx.tilt);
    }
    const path = buildPath({ p0: contact, v0, spin });
    const ball = this.newBall('serve', path, t, server.id, power);
    ball.boxSign = boxSign;
    ball.source = toss;
    this.phase = 'rally';
    this.rally = 1;
    this.ball = ball;
    this.assignReceiver(ball, this.serveReceiver());
    this.recordHit(server, t, c, power, spin, u, v0, 'serve');
    return true;
  }

  protected fault() {
    const ball = this.ball;
    if (ball) this.killBall(ball);
    this.emit({ type: 'fault', serveNumber: this.serveNumber });
    if (this.serveNumber === 2) {
      this.point(other(this.score.server), 'double-fault');
      return;
    }
    this.serveNumber = 2;
    this.rally = 0;
    this.phase = 'serve-wait';
    this.message = 'Fault';
    this.readyAt = this.clock + FAULT_PAUSE_MS;
    this.serveReadyAt = this.readyAt;
    const server = this.players[this.serverIndex];
    this.cpuServeAt = server.human ? null : this.readyAt + CPU_SERVE_DELAY_MS * 0.6;
  }

  // ---- rally ----

  protected onBallEvent(ball: Ball) {
    const event = ball.path.events[ball.cursor++];
    if (ball.kind === 'toss') return;
    if (ball.dead || this.phase !== 'rally' || ball !== this.ball) {
      if (event.kind === 'bounce') this.emit({ type: 'bounce', pos: event.pos, in: this.inCourt(event.pos, null) });
      return;
    }
    const hitter = this.players[ball.hitter];
    const receiverSide = other(hitter.side);
    if (event.kind === 'net') {
      this.emit({ type: 'net' });
      if (ball.kind === 'serve') this.fault();
      else this.point(receiverSide, 'net');
      return;
    }
    if (event.index === 1) {
      const onOwnSide = event.pos.z * sideSign(hitter.side) > 0;
      const isIn = !onOwnSide && (ball.kind === 'serve'
        ? this.inServiceBox(event.pos, receiverSide, ball.boxSign)
        : this.inCourt(event.pos, receiverSide));
      this.emit({ type: 'bounce', pos: event.pos, in: isIn });
      if (isIn) return;
      if (ball.kind === 'serve') this.fault();
      else this.point(receiverSide, onOwnSide ? 'net' : 'out');
      return;
    }
    this.emit({ type: 'bounce', pos: event.pos, in: this.inCourt(event.pos, receiverSide) });
  }

  protected onCpuHit(ball: Ball) {
    ball.cpuHitAt = null;
    if (ball !== this.ball || ball.dead) return;
    if (ball.kind === 'toss') {
      if (this.phase !== 'toss') return;
      const plan = cpuServe(this.players[ball.hitter].cpu ?? this.config.level, this.rng, this.serveNumber);
      this.serve(ball, this.clock, plan.power, plan.spin, { u: plan.u, sd: plan.sd }, null);
      return;
    }
    if (this.phase !== 'rally' || ball.receiver === null) return;
    const p = this.players[ball.receiver];
    const at = pathPosition(ball.path, (this.clock - ball.t0) / 1000);
    if (Math.hypot(at.x - p.pos.x, at.z - p.pos.z) > p.reach + 0.15) return;
    const tStar = ball.plan ? ball.t0 + ball.plan.t * 1000 : this.clock;
    // The CPU's timing is measured against the Normal unit, whatever window the humans play with.
    const u = (this.clock - tStar) / HIT_WINDOW_MS.normal;
    const halfWidth = this.halfWidth();
    const opponents = this.sidePlayers(other(p.side));
    const receiverX = opponents.length === 1 ? opponents[0].pos.x : null;
    const receiverDepth = opponents.length === 1 ? Math.abs(opponents[0].pos.z) : null;
    const incoming = speedKmh(pathVelocity(ball.path, 0));
    const tuning = p.cpu ?? LEVELS[this.config.level];
    const choice = cpuShot(tuning, this.rng, p.side, halfWidth, receiverX, pressureFrom(incoming), receiverDepth);
    const p0 = this.contactFrom(ball, this.clock, p.side);
    // The same contact model as a human, with the level's own placement error.
    const c = locateContact({
      u, spin: choice.spin, height: p0.y, rushed: ball.rushed, lateral: Math.abs(p0.x - p.pos.x),
      extraNoise: tuning.faceSd,
    }, this.rng);
    if (c.kind === 'miss') {
      // A clean miss: the ball runs on and the point is lost when it dies.
      this.whiff(ball, p);
      return;
    }
    let v0: Vec3;
    if (choice.intoNet) v0 = launchVelocity(p0, choice.target, choice.flight, choice.spin);
    else if (c.kind === 'frame') v0 = this.shankVelocity(p0, p.side, choice.spin, halfWidth);
    else {
      const fx = strikeEffect(c, wideSign(choice.target.x, p0.x - p.pos.x), choice.power, choice.spin, this.rng);
      // Lost power makes the ball shorter and slower.
      const loss = 1 - fx.transfer;
      const toward = -sideSign(p.side);
      const depth = Math.max(1.5, Math.abs(choice.target.z) + fx.ddepth - CPU_LOSS.depth * loss);
      const target = vec(choice.target.x + fx.dx, GROUND_Y, toward * depth);
      v0 = tiltLaunch(solveShot(p0, target, choice.flight + CPU_LOSS.flight * loss, choice.spin).v0, fx.tilt);
    }
    this.launchRally(ball, p, this.clock, v0, p0, choice.spin, choice.power, c, u, false);
  }

  protected onMiss(ball: Ball) {
    ball.missAt = null;
    if (ball !== this.ball || ball.dead || this.phase !== 'rally') return;
    const winner = this.players[ball.hitter].side;
    if (ball.kind === 'serve') this.point(winner, 'ace');
    else this.point(winner, ball.plan?.reachable ? 'missed' : 'winner');
  }

  /**
   * A human's swing inside the acceptance window (DESIGN.md section 5): timing
   * is aim, and timing, spin and the situation decide where the ball meets the
   * face. A contact beyond the frame is a whiff: the ball stays in play.
   */
  protected humanStrike(ball: Ball, p: Player, swing: SwingInput, upgrade = false): boolean {
    const tStar = ball.t0 + (ball.plan?.t ?? 0) * 1000;
    const u = (swing.t - tStar) / p.window;
    const p0 = this.contactFrom(ball, swing.t, p.side);
    const c = locateContact({
      u, spin: swing.spin, height: p0.y, rushed: ball.rushed, lateral: Math.abs(p0.x - p.pos.x),
    }, this.rng);
    if (c.kind === 'miss') {
      if (!upgrade) this.whiff(ball, p);
      return false;
    }
    const halfWidth = this.halfWidth();
    let v0: Vec3;
    if (c.kind === 'frame') v0 = this.shankVelocity(p0, p.side, swing.spin, halfWidth);
    else {
      const hitSide = Math.abs(p0.x) < 0.05 ? 1 : Math.sign(p0.x);
      const aim = hitSide * clamp(u, -1, 1) * 0.75 * halfWidth;
      const fx = strikeEffect(c, wideSign(aim, p0.x - p.pos.x), swing.power, swing.spin, this.rng);
      const effective = swing.power * fx.transfer;
      const x = aim + fx.dx;
      const depth = Math.max(1.5, lerp(RALLY.shortDepth, RALLY.longDepth, effective) + fx.ddepth);
      const flight = lerp(RALLY.slowFlight, RALLY.fastFlight, effective);
      const target = vec(x, GROUND_Y, -sideSign(p.side) * depth);
      v0 = tiltLaunch(solveShot(p0, target, flight, swing.spin).v0, fx.tilt);
    }
    this.launchRally(ball, p, swing.t, v0, p0, swing.spin, swing.power, c, u, upgrade);
    return true;
  }

  /** A frame hit: weak, in any direction, often into the net (contact.ts shank). */
  protected shankVelocity(p0: Vec3, side: Side, spin: number, halfWidth: number): Vec3 {
    const sh = shank(this.rng, halfWidth);
    if (sh.intoNet) return launchVelocity(p0, vec(sh.x * 0.5, sh.netY, 0), sh.netFlight, spin);
    return solveShot(p0, vec(sh.x, GROUND_Y, -sideSign(side) * sh.depth), sh.flight, spin).v0;
  }

  protected launchRally(
    from: Ball, p: Player, t: number, v0: Vec3, p0: Vec3, spin: number, power: number,
    contact: Contact, u: number, upgrade: boolean,
  ) {
    this.killBall(from);
    const path = buildPath({ p0, v0, spin });
    const ball = this.newBall('rally', path, t, p.id, power);
    ball.source = from;
    this.ball = ball;
    if (!upgrade) this.rally++;
    this.assignReceiver(ball, this.rallyReceiver(other(p.side), path));
    this.recordHit(p, t, contact, power, spin, u, v0, null);
  }

  protected recordHit(
    p: Player, t: number, c: Contact, power: number, spin: number, u: number, v0: Vec3, stroke: 'serve' | null,
  ) {
    const kmh = Math.round(speedKmh(v0));
    p.lastSwingAt = t;
    const ballX = this.ball ? this.ball.path.segments[0].p0.x : p.pos.x;
    const stance = stanceFor(p.side, p.pos.x, ballX, p.leftHanded);
    p.stanceHold = { stance, until: this.clock + STANCE_HOLD_MS };
    if (p.human) this.stats.fastestShotKmh = Math.max(this.stats.fastestShotKmh, kmh);
    this.stats.longestRally = Math.max(this.stats.longestRally, this.rally);
    p.stats.hits++;
    if (c.kind === 'frame') p.stats.frames++;
    else if (c.quality >= 0.7) p.stats.sweet++;
    p.stats.fastestShotKmh = Math.max(p.stats.fastestShotKmh, kmh);
    this.emit({
      type: 'hit', player: p.id, quality: c.quality, power, spin, u, speedKmh: kmh,
      contact: { a: c.a, b: c.b, frame: c.kind === 'frame' }, t, stroke: stroke ?? stance,
    });
  }

  /** Ball position at host time t from the ball's history, kept on the hitter's side of the net. */
  protected contactFrom(ball: Ball, t: number, side: Side): Vec3 {
    const pos = pathPosition(ball.path, (t - ball.t0) / 1000);
    const s = sideSign(side);
    return vec(pos.x, Math.max(pos.y, GROUND_Y + 0.05), s * Math.max(pos.z * s, 0.5));
  }

  protected assignReceiver(ball: Ball, receiver: number | null) {
    ball.receiver = receiver;
    if (receiver === null) return;
    const p = this.players[receiver];
    const now = (this.clock - ball.t0) / 1000;
    // A human's acceptance window spans T* +- ACCEPT * W: keep T* at least that long after the first bounce and
    // before the second (when the ball leaves room), so the window never opens on a ball not yet bounced or closes on a dead one.
    const room = p.human ? p.accept / 1000 : undefined;
    ball.plan = planContact(ball.path, now, this.mover(p), room, room);
    ball.moveFrom = this.clock + p.reaction * 1000;
    if (ball.plan) {
      const run = Math.hypot(ball.plan.stand.x - p.pos.x, ball.plan.stand.z - p.pos.z) / p.speed;
      ball.rushed = rushedFrom(ball.plan.t - now - p.reaction - run, ball.plan.reachable);
    }
    const second = ball.path.events.find((e) => e.kind === 'bounce' && e.index === 2);
    const last = ball.path.events[ball.path.events.length - 1];
    const deadAt = ball.t0 + (second ? second.t : (last?.t ?? 0) + 1) * 1000;
    if (p.human) {
      // The window closes at the second bounce at the latest: a dead ball cannot be struck (late messages still count for MISS_GRACE_MS).
      ball.missAt = ball.plan ? Math.min(ball.t0 + ball.plan.t * 1000 + p.accept, deadAt) + MISS_GRACE_MS : deadAt;
    } else {
      ball.missAt = deadAt;
      if (ball.plan?.reachable) {
        ball.cpuHitAt = ball.t0 + ball.plan.t * 1000 + cpuTimingNoise(p.cpu ?? this.config.level, this.rng);
      }
    }
  }

  protected newBall(kind: Ball['kind'], path: BallPath, t0: number, hitter: number, power: number): Ball {
    return {
      kind, path, t0, cursor: 0, hitter, receiver: null, plan: null, boxSign: 0, source: null, power,
      cpuHitAt: null, missAt: null, tossExpire: null, moveFrom: t0, rushed: 0, whiffed: false, dead: false,
    };
  }

  // ---- players ----

  protected sidePlayers(side: Side): Player[] {
    return this.players.filter((p) => p.side === side);
  }

  protected halfWidth() {
    return this.config.mode === 'doubles' ? COURT.doublesHalfWidth : COURT.singlesHalfWidth;
  }

  protected mover(p: Player): Mover {
    const wide = COURT.doublesHalfWidth + 3;
    return {
      pos: p.pos, side: p.side, speed: p.speed, reaction: p.reaction, reach: p.reach, leftHanded: p.leftHanded,
      minX: p.half === 1 ? -1 : -wide, maxX: p.half === -1 ? 1 : wide,
    };
  }

  /** The receiver of a rally ball: in doubles, whoever covers the half it lands in. */
  protected rallyReceiver(side: Side, path: BallPath): number | null {
    if (path.events.some((e) => e.kind === 'net')) return null;
    const team = this.sidePlayers(side);
    if (team.length === 1) return team[0].id;
    const landing = path.events.find((e) => e.kind === 'bounce');
    const x = landing ? landing.pos.x : 0;
    return (team.find((p) => p.half === (x < 0 ? -1 : 1)) ?? team[0]).id;
  }

  protected serveReceiver(): number {
    const side = other(this.score.server);
    const team = this.sidePlayers(side);
    if (team.length === 1) return team[0].id;
    const sign = sideSign(side) * (serveCourt(this.score) === 'deuce' ? 1 : -1);
    return (team.find((p) => p.half === sign) ?? team[0]).id;
  }

  protected receivingPlayer(): number | null {
    if (this.phase === 'serve-wait' || this.phase === 'toss') return this.serveReceiver();
    if (this.phase === 'rally' && this.ball && !this.ball.dead) return this.ball.receiver;
    return null;
  }

  /** Where each player stands for the next serve. */
  protected servePosition(p: Player): Vec3 {
    const s = sideSign(p.side);
    const court = serveCourt(this.score) === 'deuce' ? 1 : -1;
    if (p.id === this.serverIndex) return vec(s * court * 0.7, 0, s * (COURT.halfLength + 0.4));
    if (p.id === this.serveReceiver()) return vec(s * court * 2.6, 0, s * (COURT.halfLength + 0.6));
    return this.home(p);
  }

  protected home(p: Player): Vec3 {
    const s = sideSign(p.side);
    return p.half === 0 ? vec(0, 0, s * 12.6) : vec(p.half * 2.6, 0, s * 12.4);
  }

  protected target(p: Player): Vec3 {
    if (this.phase === 'point-over') return this.servePosition(p);
    if (this.phase !== 'rally') return p.pos;
    const ball = this.ball;
    if (ball && !ball.dead && ball.receiver === p.id && ball.plan) return ball.plan.stand;
    return this.home(p);
  }

  /** Run every player toward their target from the current clock to time `to`. */
  protected advancePlayers(to: number) {
    if (to <= this.clock) return;
    const ball = this.ball;
    for (const p of this.players) {
      if (this.phase === 'match-over') break;
      const start = ball && ball.receiver === p.id ? Math.max(this.clock, ball.moveFrom) : this.clock;
      const dt = Math.max(0, to - start) / 1000;
      const target = this.target(p);
      const dx = target.x - p.pos.x;
      const dz = target.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-6 || dt === 0) continue;
      const step = Math.min(d, p.speed * dt);
      const s = sideSign(p.side);
      p.pos = vec(p.pos.x + (dx / d) * step, 0, s * Math.max((p.pos.z + (dz / d) * step) * s, 0.5));
    }
    this.clock = to;
  }

  protected stanceOf(p: Player): PlayerView['stance'] {
    if ((this.phase === 'serve-wait' || this.phase === 'toss') && p.id === this.serverIndex) return 'serve';
    if (p.stanceHold && this.clock < p.stanceHold.until) return p.stanceHold.stance;
    const ball = this.ball;
    if (this.phase === 'rally' && ball && !ball.dead && ball.receiver === p.id && ball.plan) {
      return stanceFor(p.side, p.pos.x, ball.plan.pos.x, p.leftHanded);
    }
    return 'ready';
  }

  // ---- court ----

  /** Inside the court lines on `side` (either side when null). */
  protected inCourt(pos: Vec3, side: Side | null): boolean {
    if (side && pos.z * sideSign(side) < 0) return false;
    return Math.abs(pos.z) <= COURT.halfLength + LINE && Math.abs(pos.x) <= this.halfWidth() + LINE;
  }

  protected inServiceBox(pos: Vec3, side: Side, boxSign: number): boolean {
    const depth = pos.z * sideSign(side);
    return depth > 0 && depth <= COURT.serviceLine + LINE
      && pos.x * boxSign >= -LINE && Math.abs(pos.x) <= COURT.singlesHalfWidth + LINE;
  }

  protected ballView(ball: Ball | null): BallView {
    if (!ball) {
      const server = this.players[this.serverIndex];
      const s = sideSign(server.side);
      return {
        pos: vec(server.pos.x + 0.25, 1.0, server.pos.z - s * 0.3), vel: vec(0, 0, 0), spin: 0,
        visible: !this.ballHidden, bounces: 0, landing: null,
      };
    }
    const t = (this.clock - ball.t0) / 1000;
    const bounces = ball.path.events.filter((e) => e.kind === 'bounce' && e.t <= t).length;
    const first = ball.path.events[0];
    const landing = ball.kind !== 'toss' && first && first.kind === 'bounce' && first.t > t ? { ...first.pos } : null;
    return {
      pos: pathPosition(ball.path, t),
      vel: pathVelocity(ball.path, t),
      spin: pathSpin(ball.path, t),
      visible: !this.ballHidden,
      bounces,
      landing,
    };
  }
}

const REASON_MESSAGE: Record<Extract<MatchEvent, { type: 'point' }>['reason'], string> = {
  winner: 'Winner', out: 'Out', net: 'Net', 'double-fault': 'Double fault', missed: 'Missed', ace: 'Ace',
};

const emptyStats = (): PlayerStats => ({
  hits: 0, sweet: 0, frames: 0, whiffs: 0, winners: 0, aces: 0, errors: 0, doubleFaults: 0, fastestShotKmh: 0, fastestSwing: 0,
});

/** The v1 config shape as seats: `humans` humans on the near side against plain CPUs. */
function legacySeats(config: MatchConfig): SeatConfig[] {
  const humans = config.mode === 'singles' ? 1 : config.humans ?? 1;
  const human = (i: number): SeatConfig => ({ side: 'near', human: true, name: config.names?.[i], color: config.colors?.[i] });
  if (config.mode === 'singles') return [human(0), { side: 'far', human: false, name: 'CPU' }];
  return [
    human(0),
    humans === 2 ? human(1) : { side: 'near', human: false, name: 'Partner' },
    { side: 'far', human: false, name: 'CPU 1' },
    { side: 'far', human: false, name: 'CPU 2' },
  ];
}

/**
 * The match's players from its seats: near side first, then far; in doubles
 * the first seat of a side covers x < 0. Player ids are indexes in this order.
 */
export function makePlayers(config: MatchConfig): Player[] {
  const seats = config.seats ?? legacySeats(config);
  const perSide = config.mode === 'singles' ? 1 : 2;
  const ordered = [...seats.filter((s) => s.side === 'near'), ...seats.filter((s) => s.side === 'far')];
  if (ordered.length !== perSide * 2 || ordered.filter((s) => s.side === 'near').length !== perSide) {
    throw new Error(`a ${config.mode} match needs ${perSide} player${perSide > 1 ? 's' : ''} on each side`);
  }
  let humans = 0;
  let farCpus = 0;
  return ordered.map((seat, id) => {
    const half: -1 | 0 | 1 = perSide === 1 ? 0 : id % 2 === 0 ? -1 : 1;
    const style: CpuStyle | null = seat.human ? null : seat.style ?? 'allround';
    const cpu = style ? cpuTuning(style, seat.level ?? config.level) : null;
    const window = HIT_WINDOW_MS[seat.window ?? config.window];
    let name: string;
    let color: string;
    if (seat.human) {
      name = seat.name || `Player ${humans + 1}`;
      color = seat.color || HUMAN_COLORS[humans % HUMAN_COLORS.length];
      humans++;
    } else {
      name = seat.name || characterOf(style!).name;
      color = seat.color || (seat.side === 'near' ? CPU_COLORS[0] : CPU_COLORS[1 + (farCpus++ % 2)]);
    }
    return {
      id, side: seat.side, human: seat.human, name, color, half, pos: vec(0, 0, sideSign(seat.side) * 12.6),
      speed: cpu ? cpu.speed : HUMAN.speed, reaction: cpu ? cpu.reaction : HUMAN.reaction,
      reach: cpu ? cpu.reach : HUMAN.reach, leftHanded: seat.human && seat.leftHanded === true,
      window, accept: window * ACCEPT, style, cpu, machine: false, stats: emptyStats(),
      lastSwingAt: null, stanceHold: null,
    };
  });
}

/** A side's name on the score: its humans, or its CPUs when it has none ("CPU" for the v1 config shape). */
function sideLabel(players: Player[], side: Side, legacy: boolean): string {
  const team = players.filter((p) => p.side === side);
  const humans = team.filter((p) => p.human).map((p) => p.name);
  if (humans.length) return humans.join(' & ');
  return legacy ? 'CPU' : [...new Set(team.map((p) => p.name))].join(' & ');
}

/**
 * Create a match. Call update(now) every frame with host time in ms (the
 * first call starts the clock), swing() whenever a human swing arrives, and
 * view() to draw. `options` is for tests and tools; the game passes none.
 */
export function createMatch(config: MatchConfig, options: MatchOptions = {}): GameMatch {
  return new RulesMatch(config, options);
}
