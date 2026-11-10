import { LEVELS, sideSign } from './ai';
import { RulesMatch, type Ball, type GameMatch, type Player } from './match';
import { GROUND_Y, buildPath, speedKmh, vec } from './physics';
import { uniform } from './rng';
import { solveShot } from './solver';
import {
  COURT, type DrillView, type HitWindow, type Level, type MatchEvent, type MatchView, type Side, type TargetView, type Vec3,
} from './types';

/**
 * Drills: practice at targets and the tutorial (docs/v2/PLAN.md M1). One human
 * on the near side, a ball machine on the far side. A drill is a list of
 * stations; each station feeds balls (or asks for serves) and counts the ones
 * that meet its goal.
 *
 * It is the match engine with the point replaced: the human's swing goes
 * through the same contact model, timing rules and lag compensation as a
 * match, so what a player learns here is what a match will do.
 */

export type FeedSide = 'forehand' | 'backhand' | 'alternate' | 'random';
/** What makes a ball count at a station. */
export type Goal = 'in' | 'target' | 'topspin' | 'slice' | 'serve-in';
/** Targets shown: none, the cross-court half, the down-the-line half, or three zones with one lit per ball. */
export type TargetSet = 'none' | 'cross' | 'line' | 'zones';

export interface Station {
  title: string;
  /** One short line: what to do. */
  hint: string;
  kind: 'feed' | 'serve';
  feed?: FeedSide;
  /** Feed pace, 0 (slow) to 1 (quick). */
  pace?: number;
  targets?: TargetSet;
  /** Zone width for 'zones', m. */
  zone?: number;
  goal: Goal;
  /** Tutorial: balls that must meet the goal. */
  need?: number;
  /** Practice: the station ends after this many balls, whatever they did. */
  balls?: number;
}

export interface DrillConfig {
  kind: 'practice' | 'tutorial';
  stations: Station[];
  window: HitWindow;
  name?: string;
  color?: string;
  leftHanded?: boolean;
  seed?: number;
}

/** Pause after a ball's result, ms, and before the first feed of a station (time to read the hint). */
export const DRILL_PAUSE_MS = 1000;
export const FEED_DELAY_MS = 900;
export const STATION_INTRO_MS = 2600;
/** Points per ball in practice. */
export const DRILL_POINTS = { target: 3, in: 1 };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const LINE = 0.025;

type Result = NonNullable<DrillView['last']>;

const RESULT_MESSAGE: Record<Result, string> = {
  target: 'On target', in: 'In', out: 'Out', net: 'Net', missed: 'Missed', fault: 'Fault',
};

class DrillMatch extends RulesMatch {
  private readonly stations: Station[];
  private readonly kind: DrillConfig['kind'];
  private stationIndex = 0;
  private done = 0;
  private used = 0;
  private tally = 0;
  private streak = 0;
  private bestStreak = 0;
  private last: Result | null = null;
  private finished = false;
  /** Court x sign of the side the next (or current) feed goes to. */
  private ballSide = 1;
  private feeds = 0;
  private targets: TargetView[] = [];
  /** Spin of the human's last hit, for the spin goals. */
  private lastSpin = 0;
  private intro = true;

  constructor(drill: DrillConfig) {
    super({
      mode: 'singles',
      seats: [
        { side: 'near', human: true, name: drill.name, color: drill.color, leftHanded: drill.leftHanded },
        { side: 'far', human: false, name: 'Ball machine', color: '#f2d7a6' },
      ],
      level: 'rookie', window: drill.window, length: 'game1', seed: drill.seed,
    });
    if (!drill.stations.length) throw new Error('a drill needs at least one station');
    this.stations = drill.stations;
    this.kind = drill.kind;
    const machine = this.machine;
    machine.machine = true;
    machine.speed = 0;
    machine.reach = 0;
    machine.cpu = { ...LEVELS.rookie, speed: 0, reach: 0 };
  }

  private get human(): Player { return this.players[0]; }
  private get machine(): Player { return this.players[1]; }
  private get station(): Station { return this.stations[Math.min(this.stationIndex, this.stations.length - 1)]; }

  skip(): void {
    if (this.finished || !this.started) return;
    if (this.ball) this.killBall(this.ball);
    this.last = null;
    this.nextStation();
    if (!this.finished) this.startPoint();
  }

  view(): MatchView {
    const st = this.station;
    return {
      ...super.view(),
      drill: {
        kind: this.kind, title: st.title, hint: st.hint, targets: this.targets.map((t) => ({ ...t })),
        done: st.balls !== undefined ? this.used : this.done, need: st.balls ?? st.need ?? 1,
        station: this.stationIndex, stations: this.stations.length,
        score: this.tally, streak: this.streak, bestStreak: this.bestStreak, last: this.last,
      },
    };
  }

  // ---- one ball ----

  protected startPoint() {
    const st = this.station;
    this.serverIndex = st.kind === 'serve' ? this.human.id : this.machine.id;
    super.startPoint();
    this.cpuServeAt = null;
    if (st.kind === 'feed') {
      this.ballSide = this.nextSide(st.feed ?? 'forehand');
      this.cpuServeAt = this.clock + (this.intro ? STATION_INTRO_MS : FEED_DELAY_MS);
    }
    this.targets = this.makeTargets(st);
    this.intro = false;
  }

  /** The machine's turn: feed a ball. */
  protected onCpuServe() {
    this.cpuServeAt = null;
    if (this.phase !== 'serve-wait' || this.station.kind !== 'feed') return;
    const st = this.station;
    const machine = this.machine;
    const pace = Math.max(0, Math.min(1, st.pace ?? 0.3));
    const p0 = vec(machine.pos.x, 1.1, machine.pos.z + 0.6);
    const landing = vec(this.ballSide * uniform(this.rng, 1.7, 2.5), GROUND_Y, uniform(this.rng, 8, 9.6));
    const v0 = solveShot(p0, landing, lerp(1.5, 1.05, pace), 0.2).v0;
    const ball = this.newBall('rally', buildPath({ p0, v0, spin: 0.2 }), this.clock, machine.id, pace);
    this.message = null;
    this.phase = 'rally';
    this.rally = 1;
    this.ball = ball;
    this.assignReceiver(ball, this.human.id);
    machine.lastSwingAt = this.clock;
    this.emit({
      type: 'hit', player: machine.id, quality: 1, power: pace, spin: 0.2, u: 0, speedKmh: Math.round(speedKmh(v0)),
      contact: { a: -0.15, b: 0, frame: false }, t: this.clock, stroke: 'forehand',
    });
  }

  /** The human's ball: decided at the net or at its first bounce. The machine's feed uses the match rules. */
  protected onBallEvent(ball: Ball) {
    const mine = ball.kind !== 'toss' && !ball.dead && this.phase === 'rally' && ball === this.ball && ball.hitter === this.human.id;
    if (!mine) { super.onBallEvent(ball); return; }
    const event = ball.path.events[ball.cursor++];
    const serve = ball.kind === 'serve';
    if (event.kind === 'net') {
      this.emit({ type: 'net' });
      this.finish(serve ? 'fault' : 'net');
      return;
    }
    if (event.index !== 1) return;
    const isIn = serve ? this.inServiceBox(event.pos, 'far', ball.boxSign) : this.inCourt(event.pos, 'far');
    this.emit({ type: 'bounce', pos: event.pos, in: isIn });
    if (!isIn) { this.finish(serve ? 'fault' : 'out'); return; }
    this.finish(this.onTarget(event.pos) ? 'target' : 'in');
  }

  /** Every way the match rules end a ball lands here: a missed feed, a feed that went astray, a serve fault. */
  protected point(_winner: Side, reason: Extract<MatchEvent, { type: 'point' }>['reason']) {
    if (this.phase === 'point-over' || this.phase === 'match-over') return;
    if (reason === 'missed') this.finish('missed');
    else if (reason === 'double-fault') this.finish('fault');
    else {
      // The feed itself failed (it cannot, but a ball nobody could reach must not count against the player): feed again.
      if (this.ball) this.killBall(this.ball);
      this.phase = 'point-over';
      this.phaseUntil = this.clock + FEED_DELAY_MS;
    }
  }

  /** A serve into the net or out is one fault here: no second serve, the station just asks again. */
  protected fault() {
    this.emit({ type: 'fault', serveNumber: 1 });
    this.finish('fault');
  }

  protected recordHit(...args: Parameters<RulesMatch['recordHit']>) {
    super.recordHit(...args);
    if (args[0].id === this.human.id) this.lastSpin = args[4];
  }

  private finish(result: Result) {
    if (this.phase === 'point-over' || this.phase === 'match-over') return;
    if (this.ball) this.killBall(this.ball);
    const st = this.station;
    const good = this.meets(st.goal, result);
    this.last = result;
    this.used++;
    const landedIn = result === 'target' || result === 'in';
    this.streak = landedIn ? this.streak + 1 : 0;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    if (result === 'target') this.tally += DRILL_POINTS.target;
    else if (result === 'in') this.tally += DRILL_POINTS.in;
    if (good) this.done++;
    this.message = RESULT_MESSAGE[result];
    const stationDone = st.balls !== undefined ? this.used >= st.balls : this.done >= (st.need ?? 1);
    if (stationDone) this.nextStation();
    this.emit({ type: 'drill', result, score: this.tally, stationDone, finished: this.finished });
    if (this.finished) return;
    this.phase = 'point-over';
    this.phaseUntil = this.clock + DRILL_PAUSE_MS;
  }

  private nextStation() {
    this.stationIndex++;
    this.done = 0;
    this.used = 0;
    this.intro = true;
    if (this.stationIndex < this.stations.length) return;
    this.finished = true;
    this.stationIndex = this.stations.length - 1;
    this.targets = [];
    this.winner = 'near';
    this.message = this.kind === 'tutorial' ? 'Ready to play' : 'Basket empty';
    this.phase = 'match-over';
    this.phaseUntil = this.clock + DRILL_PAUSE_MS;
    this.cpuServeAt = null;
    this.emit({ type: 'match', winner: 'near' });
  }

  private meets(goal: Goal, result: Result): boolean {
    const landedIn = result === 'target' || result === 'in';
    if (goal === 'target') return result === 'target';
    if (goal === 'topspin') return landedIn && this.lastSpin > 0.2;
    if (goal === 'slice') return landedIn && this.lastSpin < -0.2;
    return landedIn;
  }

  // ---- feeds and targets ----

  /** Court x sign of the next feed. A right-handed near player has the forehand on +x. */
  private nextSide(feed: FeedSide): number {
    const forehand = this.human.leftHanded ? -1 : 1;
    const n = this.feeds++;
    if (feed === 'forehand') return forehand;
    if (feed === 'backhand') return -forehand;
    if (feed === 'alternate') return n % 2 === 0 ? forehand : -forehand;
    return this.rng() < 0.5 ? 1 : -1;
  }

  private makeTargets(st: Station): TargetView[] {
    const set = st.targets ?? 'none';
    const hw = COURT.singlesHalfWidth;
    if (set === 'none' || st.kind === 'serve') return [];
    if (set === 'cross' || set === 'line') {
      // Early swings pull the ball across the court, late ones push it down the line: each is one half of the far court.
      const side = set === 'cross' ? -this.ballSide : this.ballSide;
      const near = 2;
      return [{
        x: side * hw / 2, z: -(near + COURT.halfLength) / 2, w: hw, d: COURT.halfLength - near, lit: true,
        label: set === 'cross' ? 'Cross-court' : 'Down the line',
      }];
    }
    const w = st.zone ?? 2.4;
    const d = 4.5;
    const z = -8.5;
    const lit = Math.floor(this.rng() * 3);
    const xs = [-(hw - w / 2 - 0.15), 0, hw - w / 2 - 0.15];
    return xs.map((x, i) => ({
      x, z, w, d, lit: i === lit,
      label: x === 0 ? 'Middle' : Math.sign(x) === this.ballSide ? 'Down the line' : 'Cross-court',
    }));
  }

  private onTarget(pos: Vec3): boolean {
    return this.targets.some((t) => t.lit
      && Math.abs(pos.x - t.x) <= t.w / 2 + LINE && Math.abs(pos.z - t.z) <= t.d / 2 + LINE);
  }

  // ---- positions ----

  protected servePosition(p: Player): Vec3 {
    if (p.machine) return vec(0, 0, sideSign(p.side) * (COURT.halfLength + 1));
    return this.station.kind === 'serve' ? super.servePosition(p) : this.home(p);
  }

  protected target(p: Player): Vec3 {
    return p.machine ? p.pos : super.target(p);
  }
}

// ---- ready-made drills ----

/** The tutorial: each lesson is passed by doing it (docs/v2/BRIEF.md pillar 3). */
export function tutorialStations(): Station[] {
  return [
    { title: 'Hit it back', hint: 'Swing as the ball reaches you.', kind: 'feed', feed: 'forehand', pace: 0.15, goal: 'in', need: 3 },
    {
      title: 'Swing early', hint: 'An early swing pulls the ball across the court.',
      kind: 'feed', feed: 'forehand', pace: 0.15, targets: 'cross', goal: 'target', need: 2,
    },
    {
      title: 'Swing late', hint: 'A late swing sends it down the line.',
      kind: 'feed', feed: 'forehand', pace: 0.15, targets: 'line', goal: 'target', need: 2,
    },
    { title: 'The other side', hint: 'Same swing, on your backhand.', kind: 'feed', feed: 'backhand', pace: 0.15, goal: 'in', need: 2 },
    { title: 'Serve', hint: 'Swing once to toss, again at the top to hit.', kind: 'serve', goal: 'serve-in', need: 2 },
    { title: 'Topspin', hint: 'Brush up the back of the ball, low to high.', kind: 'feed', feed: 'forehand', pace: 0.15, goal: 'topspin', need: 1 },
  ];
}

/** Target practice: one basket, a lit zone to aim at on every ball. */
export function practiceStations(level: Level, balls = 15): Station[] {
  const pace = level === 'rookie' ? 0.2 : level === 'club' ? 0.5 : 0.8;
  const zone = level === 'rookie' ? 2.6 : level === 'club' ? 2.1 : 1.6;
  return [{
    title: 'Target practice', hint: 'Aim for the lit zone: early goes across, late goes down the line.',
    kind: 'feed', feed: 'alternate', pace, targets: 'zones', zone, goal: 'target', balls,
  }];
}

/** Create a drill. It is driven exactly like a match: update(now), swing(), view(). */
export function createDrill(config: DrillConfig): GameMatch {
  return new DrillMatch(config);
}
