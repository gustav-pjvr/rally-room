import {
  HUMAN, LEVELS, cpuServe, cpuShot, cpuTimingNoise, planContact, pressureFrom, sideSign, stanceFor,
  type ContactPlan, type Mover,
} from './ai';
import {
  GROUND_Y, buildPath, pathPosition, pathSpin, pathVelocity, speedKmh, vec, type BallPath,
} from './physics';
import { createRng, gauss, type Rng } from './rng';
import { awardPoint, createScore, other, scoreView, serveCourt, type ScoreState } from './scoring';
import { launchVelocity, solveShot } from './solver';
import {
  COURT, type BallView, type HitWindow, type Match, type MatchConfig, type MatchEvent, type MatchView,
  type Phase, type PlayerView, type Side, type SwingInput, type Vec3,
} from './types';

/**
 * The match state machine (DESIGN.md section 5): serve-wait, toss, rally,
 * point-over, match-over. All times are host milliseconds; ball paths are
 * analytic, so the ball's history is exact and lag compensation re-launches
 * the ball from where it really was at the swing's time.
 */

/** Hit window W per setting, ms. */
export const HIT_WINDOW_MS: Record<HitWindow, number> = { easy: 180, normal: 130, pro: 90 };
/** A miss is declared only this long after T* + W, so late swing messages (up to 300 ms old, types.ts) still count. */
export const MISS_GRACE_MS = 300;
export const POINT_PAUSE_MS = 1600;
export const FAULT_PAUSE_MS = 1000;
/** A CPU server waits this long after the point is ready. */
export const CPU_SERVE_DELAY_MS = 1000;
/** Toss: released at 1.5 m going up at 5.4 m/s, so it peaks near 3 m and is back at 1.5 m after 1.1 s. */
export const TOSS = { releaseY: 1.5, vy: 5.4, hitFromMs: 250, hitUntilMs: 1150 };
const TOSS_APEX_MS = (TOSS.vy / 9.81) * 1000;
/** Serve timing: |u| = 1 this far from the top of the toss, ms. */
export const SERVE_TIMING_MS = 550;
/** A serve struck below this height goes into the net. */
export const SERVE_MIN_HEIGHT = 1.9;
/** Rally shots: flight time 1.6 s (soft) to 0.75 s (full power); depth 5 to 10.5 m past the net. */
export const RALLY = { slowFlight: 1.6, fastFlight: 0.75, shortDepth: 5, longDepth: 10.5 };
/** Serves: flight time and depth past the net by power. */
export const SERVE = { slowFlight: 1.2, fastFlight: 0.6, shortDepth: 4.4, longDepth: 5.7 };
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

interface Player {
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
  lastSwingAt: number | null;
  stanceHold: { stance: 'forehand' | 'backhand'; until: number } | null;
}

interface Ball {
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
  whiffed: boolean;
  /** No longer decides anything (point over, fault). */
  dead: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

class RulesMatch implements GameMatch {
  private readonly rng: Rng;
  private readonly players: Player[];
  private readonly window: number;
  private readonly labels: [string, string];
  private score: ScoreState;
  private phase: Phase = 'serve-wait';
  private clock = 0;
  private started = false;
  private ball: Ball | null = null;
  private ballHidden = false;
  private serveNumber: 1 | 2 = 1;
  private serverIndex = 0;
  private serveTurns: [number, number];
  private rally = 0;
  private message: string | null = null;
  private winner: Side | null = null;
  private readyAt: number | null = null;
  /** Host ms from which a swing may start the toss: when serve-wait became ready (swings dated earlier are stale). */
  private serveReadyAt = -Infinity;
  private cpuServeAt: number | null = null;
  private phaseUntil: number | null = null;
  private stats = { longestRally: 0, fastestShotKmh: 0 };
  private pending: MatchEvent[] = [];

  constructor(private readonly config: MatchConfig, options: MatchOptions = {}) {
    this.rng = createRng(config.seed ?? Date.now());
    this.window = HIT_WINDOW_MS[config.window];
    this.players = makePlayers(config);
    const humans = this.players.filter((p) => p.human).map((p) => p.name);
    this.labels = [humans.join(' & '), 'CPU'];
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
    const ball = this.ball;
    if (this.phase === 'serve-wait' && this.serverIndex === p.id) {
      if (swing.t >= this.serveReadyAt) this.toss(p, swing.t);
      return;
    }
    if (this.phase === 'toss' && ball?.kind === 'toss' && this.serverIndex === p.id) {
      const dt = swing.t - ball.t0;
      if (dt >= TOSS.hitFromMs && dt <= TOSS.hitUntilMs) this.serve(ball, swing.t, swing.power, swing.spin, null);
      return;
    }
    if (this.phase !== 'rally' || !ball || ball.dead) return;
    // Already served: a stronger swing inside the toss window replaces the serve.
    const toss = ball.source;
    if (ball.kind === 'serve' && ball.hitter === p.id && toss?.kind === 'toss' && ball.cursor === 0
      && swing.power > ball.power) {
      const dt = swing.t - toss.t0;
      if (dt >= TOSS.hitFromMs && dt <= TOSS.hitUntilMs) {
        this.killBall(ball);
        this.serve(toss, swing.t, swing.power, swing.spin, null);
      }
      return;
    }
    // The incoming ball, not yet returned.
    if (ball.receiver === p.id && ball.plan) {
      const tStar = ball.t0 + ball.plan.t * 1000;
      // A swing can never strike the ball before its first bounce.
      if (swing.t < this.firstBounceAt(ball)) return;
      if (Math.abs(swing.t - tStar) > this.window || this.clock > tStar + this.window + MISS_GRACE_MS) return;
      if (ball.plan.reachable) this.humanStrike(ball, p, swing);
      else if (!ball.whiffed) {
        ball.whiffed = true;
        this.emit({ type: 'whiff', player: p.id });
      }
      return;
    }
    // Already returned: a stronger swing inside the same window replaces the shot.
    const source = ball.source;
    if (ball.hitter === p.id && source?.plan && source.receiver === p.id && ball.cursor === 0
      && swing.power > ball.power) {
      const tStar = source.t0 + source.plan.t * 1000;
      if (swing.t >= this.firstBounceAt(source) && Math.abs(swing.t - tStar) <= this.window) this.humanStrike(source, p, swing, true);
    }
  }

  /** Host ms of the ball's first bounce (-Infinity when it has none). */
  private firstBounceAt(ball: Ball): number {
    const first = ball.path.events.find((e) => e.kind === 'bounce' && e.index === 1);
    return first ? ball.t0 + first.t * 1000 : -Infinity;
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
      stats: { ...this.stats },
    };
  }

  // ---- scheduling ----

  private nextDue(): { t: number; run: () => void } | null {
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

  private emit(event: MatchEvent) {
    this.pending.push(event);
  }

  // ---- points ----

  private startPoint() {
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

  private point(winner: Side, reason: Extract<MatchEvent, { type: 'point' }>['reason']) {
    if (this.phase === 'point-over' || this.phase === 'match-over') return;
    if (this.ball) this.killBall(this.ball);
    this.emit({ type: 'point', winner, reason });
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
  private syncServer() {
    const side = this.score.server;
    if (this.players[this.serverIndex].side === side) return;
    const i = side === 'near' ? 0 : 1;
    this.serveTurns[i]++;
    const team = this.sidePlayers(side);
    this.serverIndex = team[this.serveTurns[i] % team.length].id;
  }

  private onPhaseEnd() {
    this.phaseUntil = null;
    if (this.phase === 'match-over') this.ballHidden = true;
    else if (this.phase === 'point-over') this.startPoint();
  }

  private onReady() {
    this.readyAt = null;
    this.message = null;
    if (this.phase === 'serve-wait') this.ball = null;
  }

  private killBall(ball: Ball) {
    ball.dead = true;
    ball.cpuHitAt = null;
    ball.missAt = null;
    ball.tossExpire = null;
  }

  // ---- serving ----

  private toss(server: Player, t: number) {
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
      const timing = gauss(this.rng, LEVELS[this.config.level].timingSd);
      ball.cpuHitAt = t + TOSS_APEX_MS + timing;
    }
    this.ball = ball;
    this.phase = 'toss';
    this.emit({ type: 'toss', player: server.id });
  }

  private onTossExpire(ball: Ball) {
    // An unhit toss is caught and tossed again: no fault.
    ball.tossExpire = null;
    if (this.ball !== ball || this.phase !== 'toss') return;
    this.phase = 'serve-wait';
    this.serveReadyAt = this.clock;
    this.ball = null;
  }

  private onCpuServe() {
    this.cpuServeAt = null;
    if (this.phase !== 'serve-wait') return;
    this.toss(this.players[this.serverIndex], this.clock);
  }

  /** Strike the serve from the toss at host time t. `cpu` carries the CPU's placement error. */
  private serve(toss: Ball, t: number, power: number, spin: number, cpu: { u: number; sd: number } | null) {
    toss.tossExpire = null;
    toss.cpuHitAt = null;
    const server = this.players[toss.hitter];
    const contact = pathPosition(toss.path, (t - toss.t0) / 1000);
    const u = cpu ? cpu.u : clamp((t - (toss.t0 + TOSS_APEX_MS)) / SERVE_TIMING_MS, -1, 1);
    const deuce = serveCourt(this.score) === 'deuce';
    const s = sideSign(server.side);
    const boxSign = -s * (deuce ? 1 : -1);
    // Early (u < 0) goes wide, late (u > 0) goes down the T.
    let x = boxSign * clamp(2.05 - u * 1.6, 0.3, 3.8);
    let depth = lerp(SERVE.shortDepth, SERVE.longDepth, power);
    if (cpu) {
      x += gauss(this.rng, cpu.sd);
      depth += gauss(this.rng, cpu.sd);
    } else {
      const risk = this.riskError(u, power, spin);
      x += risk.x;
      depth += risk.depth;
    }
    let v0: Vec3;
    if (contact.y < SERVE_MIN_HEIGHT) {
      // Struck too low: no angle to get over, it goes into the net.
      v0 = launchVelocity(contact, vec(x * 0.3, 0.5, 0), 0.45, spin);
    } else {
      const flight = lerp(SERVE.slowFlight, SERVE.fastFlight, power);
      v0 = solveShot(contact, vec(x, GROUND_Y, -s * depth), flight, spin).v0;
    }
    const path = buildPath({ p0: contact, v0, spin });
    const ball = this.newBall('serve', path, t, server.id, power);
    ball.boxSign = boxSign;
    ball.source = toss;
    this.phase = 'rally';
    this.rally = 1;
    this.ball = ball;
    this.assignReceiver(ball, this.serveReceiver());
    this.recordHit(server, t, 1 - Math.abs(u), power, spin, u, v0);
  }

  private fault() {
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

  private onBallEvent(ball: Ball) {
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

  private onCpuHit(ball: Ball) {
    ball.cpuHitAt = null;
    if (ball !== this.ball || ball.dead) return;
    if (ball.kind === 'toss') {
      if (this.phase !== 'toss') return;
      const plan = cpuServe(this.config.level, this.rng, this.serveNumber);
      this.serve(ball, this.clock, plan.power, plan.spin, { u: plan.u, sd: plan.sd });
      return;
    }
    if (this.phase !== 'rally' || ball.receiver === null) return;
    const p = this.players[ball.receiver];
    const at = pathPosition(ball.path, (this.clock - ball.t0) / 1000);
    if (Math.hypot(at.x - p.pos.x, at.z - p.pos.z) > p.reach + 0.15) return;
    const tStar = ball.plan ? ball.t0 + ball.plan.t * 1000 : this.clock;
    const u = clamp((this.clock - tStar) / this.window, -1, 1);
    const halfWidth = this.halfWidth();
    const opponents = this.sidePlayers(other(p.side));
    const receiverX = opponents.length === 1 ? opponents[0].pos.x : null;
    const incoming = speedKmh(pathVelocity(ball.path, 0));
    const choice = cpuShot(this.config.level, this.rng, p.side, halfWidth, receiverX, pressureFrom(incoming));
    const p0 = this.contactFrom(ball, this.clock, p.side);
    const v0 = choice.intoNet
      ? launchVelocity(p0, choice.target, choice.flight, choice.spin)
      : solveShot(p0, choice.target, choice.flight, choice.spin).v0;
    this.launchRally(ball, p, this.clock, v0, p0, choice.spin, choice.power, 1 - Math.abs(u), u, false);
  }

  private onMiss(ball: Ball) {
    ball.missAt = null;
    if (ball !== this.ball || ball.dead || this.phase !== 'rally') return;
    const winner = this.players[ball.hitter].side;
    if (ball.kind === 'serve') this.point(winner, 'ace');
    else this.point(winner, ball.plan?.reachable ? 'missed' : 'winner');
  }

  /** A human's swing inside the window: timing is aim (DESIGN.md section 5). */
  private humanStrike(ball: Ball, p: Player, swing: SwingInput, upgrade = false) {
    const tStar = ball.t0 + (ball.plan?.t ?? 0) * 1000;
    const u = clamp((swing.t - tStar) / this.window, -1, 1);
    const p0 = this.contactFrom(ball, swing.t, p.side);
    const halfWidth = this.halfWidth();
    const hitSide = Math.abs(p0.x) < 0.05 ? 1 : Math.sign(p0.x);
    const risk = this.riskError(u, swing.power, swing.spin);
    const x = hitSide * u * 0.75 * halfWidth + risk.x;
    const depth = lerp(RALLY.shortDepth, RALLY.longDepth, swing.power) + risk.depth;
    const flight = lerp(RALLY.slowFlight, RALLY.fastFlight, swing.power);
    const target = vec(x, GROUND_Y, -sideSign(p.side) * depth);
    const { v0 } = solveShot(p0, target, flight, swing.spin);
    this.launchRally(ball, p, swing.t, v0, p0, swing.spin, swing.power, 1 - Math.abs(u), u, upgrade);
  }

  private launchRally(
    from: Ball, p: Player, t: number, v0: Vec3, p0: Vec3, spin: number, power: number,
    quality: number, u: number, upgrade: boolean,
  ) {
    this.killBall(from);
    const path = buildPath({ p0, v0, spin });
    const ball = this.newBall('rally', path, t, p.id, power);
    ball.source = from;
    this.ball = ball;
    if (!upgrade) this.rally++;
    this.assignReceiver(ball, this.rallyReceiver(other(p.side), path));
    this.recordHit(p, t, quality, power, spin, u, v0);
  }

  private recordHit(p: Player, t: number, quality: number, power: number, spin: number, u: number, v0: Vec3) {
    const kmh = Math.round(speedKmh(v0));
    p.lastSwingAt = t;
    const ballX = this.ball ? this.ball.path.segments[0].p0.x : p.pos.x;
    p.stanceHold = { stance: stanceFor(p.side, p.pos.x, ballX), until: this.clock + STANCE_HOLD_MS };
    if (p.human) this.stats.fastestShotKmh = Math.max(this.stats.fastestShotKmh, kmh);
    this.stats.longestRally = Math.max(this.stats.longestRally, this.rally);
    this.emit({ type: 'hit', player: p.id, quality, power, spin, u, speedKmh: kmh });
  }

  /** Width error for extreme timing, length error for a flat full swing (DESIGN.md section 5). */
  private riskError(u: number, power: number, spin: number) {
    let x = 0;
    let depth = 0;
    if (Math.abs(u) > 0.8) x = gauss(this.rng, 1.6 * (Math.abs(u) - 0.8) / 0.2);
    if (power > 0.9 && Math.abs(spin) < 0.2) depth = gauss(this.rng, 1.8 * (power - 0.9) / 0.1);
    return { x, depth };
  }

  /** Ball position at host time t from the ball's history, kept on the hitter's side of the net. */
  private contactFrom(ball: Ball, t: number, side: Side): Vec3 {
    const pos = pathPosition(ball.path, (t - ball.t0) / 1000);
    const s = sideSign(side);
    return vec(pos.x, Math.max(pos.y, GROUND_Y + 0.05), s * Math.max(pos.z * s, 0.5));
  }

  private assignReceiver(ball: Ball, receiver: number | null) {
    ball.receiver = receiver;
    if (receiver === null) return;
    const p = this.players[receiver];
    const now = (this.clock - ball.t0) / 1000;
    // A human's hit window opens W before T*: keep T* at least W after the first bounce.
    ball.plan = planContact(ball.path, now, this.mover(p), p.human ? this.window / 1000 : undefined);
    ball.moveFrom = this.clock + p.reaction * 1000;
    const second = ball.path.events.find((e) => e.kind === 'bounce' && e.index === 2);
    const last = ball.path.events[ball.path.events.length - 1];
    const deadAt = ball.t0 + (second ? second.t : (last?.t ?? 0) + 1) * 1000;
    if (p.human) {
      ball.missAt = ball.plan ? ball.t0 + ball.plan.t * 1000 + this.window + MISS_GRACE_MS : deadAt;
    } else {
      ball.missAt = deadAt;
      if (ball.plan?.reachable) {
        ball.cpuHitAt = ball.t0 + ball.plan.t * 1000 + cpuTimingNoise(this.config.level, this.rng);
      }
    }
  }

  private newBall(kind: Ball['kind'], path: BallPath, t0: number, hitter: number, power: number): Ball {
    return {
      kind, path, t0, cursor: 0, hitter, receiver: null, plan: null, boxSign: 0, source: null, power,
      cpuHitAt: null, missAt: null, tossExpire: null, moveFrom: t0, whiffed: false, dead: false,
    };
  }

  // ---- players ----

  private sidePlayers(side: Side): Player[] {
    return this.players.filter((p) => p.side === side);
  }

  private halfWidth() {
    return this.config.mode === 'doubles' ? COURT.doublesHalfWidth : COURT.singlesHalfWidth;
  }

  private mover(p: Player): Mover {
    const wide = COURT.doublesHalfWidth + 3;
    return {
      pos: p.pos, side: p.side, speed: p.speed, reaction: p.reaction, reach: p.reach,
      minX: p.half === 1 ? -1 : -wide, maxX: p.half === -1 ? 1 : wide,
    };
  }

  /** The receiver of a rally ball: in doubles, whoever covers the half it lands in. */
  private rallyReceiver(side: Side, path: BallPath): number | null {
    if (path.events.some((e) => e.kind === 'net')) return null;
    const team = this.sidePlayers(side);
    if (team.length === 1) return team[0].id;
    const landing = path.events.find((e) => e.kind === 'bounce');
    const x = landing ? landing.pos.x : 0;
    return (team.find((p) => p.half === (x < 0 ? -1 : 1)) ?? team[0]).id;
  }

  private serveReceiver(): number {
    const side = other(this.score.server);
    const team = this.sidePlayers(side);
    if (team.length === 1) return team[0].id;
    const sign = sideSign(side) * (serveCourt(this.score) === 'deuce' ? 1 : -1);
    return (team.find((p) => p.half === sign) ?? team[0]).id;
  }

  private receivingPlayer(): number | null {
    if (this.phase === 'serve-wait' || this.phase === 'toss') return this.serveReceiver();
    if (this.phase === 'rally' && this.ball && !this.ball.dead) return this.ball.receiver;
    return null;
  }

  /** Where each player stands for the next serve. */
  private servePosition(p: Player): Vec3 {
    const s = sideSign(p.side);
    const court = serveCourt(this.score) === 'deuce' ? 1 : -1;
    if (p.id === this.serverIndex) return vec(s * court * 0.7, 0, s * (COURT.halfLength + 0.4));
    if (p.id === this.serveReceiver()) return vec(s * court * 2.6, 0, s * (COURT.halfLength + 0.6));
    return this.home(p);
  }

  private home(p: Player): Vec3 {
    const s = sideSign(p.side);
    return p.half === 0 ? vec(0, 0, s * 12.6) : vec(p.half * 2.6, 0, s * 12.4);
  }

  private target(p: Player): Vec3 {
    if (this.phase === 'point-over') return this.servePosition(p);
    if (this.phase !== 'rally') return p.pos;
    const ball = this.ball;
    if (ball && !ball.dead && ball.receiver === p.id && ball.plan) return ball.plan.stand;
    return this.home(p);
  }

  /** Run every player toward their target from the current clock to time `to`. */
  private advancePlayers(to: number) {
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

  private stanceOf(p: Player): PlayerView['stance'] {
    if ((this.phase === 'serve-wait' || this.phase === 'toss') && p.id === this.serverIndex) return 'serve';
    if (p.stanceHold && this.clock < p.stanceHold.until) return p.stanceHold.stance;
    const ball = this.ball;
    if (this.phase === 'rally' && ball && !ball.dead && ball.receiver === p.id && ball.plan) {
      return stanceFor(p.side, p.pos.x, ball.plan.pos.x);
    }
    return 'ready';
  }

  // ---- court ----

  /** Inside the court lines on `side` (either side when null). */
  private inCourt(pos: Vec3, side: Side | null): boolean {
    if (side && pos.z * sideSign(side) < 0) return false;
    return Math.abs(pos.z) <= COURT.halfLength + LINE && Math.abs(pos.x) <= this.halfWidth() + LINE;
  }

  private inServiceBox(pos: Vec3, side: Side, boxSign: number): boolean {
    const depth = pos.z * sideSign(side);
    return depth > 0 && depth <= COURT.serviceLine + LINE
      && pos.x * boxSign >= -LINE && Math.abs(pos.x) <= COURT.singlesHalfWidth + LINE;
  }

  private ballView(ball: Ball | null): BallView {
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

function makePlayers(config: MatchConfig): Player[] {
  const humans = config.mode === 'singles' ? 1 : config.humans;
  const cpu = LEVELS[config.level];
  const players: Player[] = [];
  const add = (side: Side, half: -1 | 0 | 1, human: boolean, name: string, color: string) => {
    const id = players.length;
    players.push({
      id, side, human, name, color, half, pos: vec(0, 0, sideSign(side) * 12.6),
      speed: human ? HUMAN.speed : cpu.speed, reaction: human ? HUMAN.reaction : cpu.reaction,
      reach: human ? HUMAN.reach : cpu.reach, lastSwingAt: null, stanceHold: null,
    });
  };
  const humanName = (i: number) => config.names?.[i] || `Player ${i + 1}`;
  const humanColor = (i: number) => config.colors?.[i] || HUMAN_COLORS[i % HUMAN_COLORS.length];
  if (config.mode === 'singles') {
    add('near', 0, true, humanName(0), humanColor(0));
    add('far', 0, false, 'CPU', CPU_COLORS[1]);
  } else {
    add('near', -1, true, humanName(0), humanColor(0));
    if (humans === 2) add('near', 1, true, humanName(1), humanColor(1));
    else add('near', 1, false, 'Partner', CPU_COLORS[0]);
    add('far', -1, false, 'CPU 1', CPU_COLORS[1]);
    add('far', 1, false, 'CPU 2', CPU_COLORS[2]);
  }
  return players;
}

/**
 * Create a match. Call update(now) every frame with host time in ms (the
 * first call starts the clock), swing() whenever a human swing arrives, and
 * view() to draw. `options` is for tests and tools; the game passes none.
 */
export function createMatch(config: MatchConfig, options: MatchOptions = {}): GameMatch {
  return new RulesMatch(config, options);
}
