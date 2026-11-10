/**
 * The host game page: rules engine (createMatch) + renderer + UI + audio,
 * driven by phones (Phase 3, co-op vs CPU).
 *
 * The room is created when the page loads, one room for the whole session.
 * Phones join from the QR on the setup screen; the first two to join are
 * players 1 and 2 (src/host/phones.ts). Their swing messages drive the
 * match. A match player belongs to a phone id, not a slot: the phone that
 * comes back (reload, new tab, any slot) plays it again, and a new phone
 * watches. The keyboard stays as a fallback: Space swings for human player 1,
 * Enter for player 2; holding W adds topspin, S slice.
 *
 * Before and between matches the court plays the stub rally as a backdrop.
 * Dev URL flags: ?screen=setup|match|pause|end and ?t=<ms> (stub only).
 */
import { createRenderer } from './game/render';
import { createAudio } from './game/audio';
import { createUi, type LobbyCard } from './game/ui';
import { stubView } from './game/stub';
import { createMatch, type GameMatch } from '../engine/match';
import type { MatchConfig, MatchEvent, MatchView, Vec3 } from '../engine/types';
import { hostConnection, type PhoneMode } from './net';
import {
  assignPlayers, byJoinOrder, ChangeFilter, createSeats, DEFAULT_COLORS, eventMessages, expiredSlots, gameMessages,
  matchIdentity, missingPlayers, phoneJoined, playerOfSlot, PONG_TIMEOUT_MS, safeColor, seatIn, seatOut, seatReady,
  seatSlots, shortName, suggestedHumans, takeOverWithKeyboard, waitingText, youMessages,
  type Assignment, type Phone, type PhoneMessage, type Seat,
} from './phones';
import { PauseTimeline } from './timeline';
import { isSwing, SLOT_HOLD_MS, type Message } from '../shared/protocol';

const canvas = document.querySelector<HTMLCanvasElement>('#court')!;
const overlay = document.querySelector<HTMLElement>('#overlay')!;
const params = new URLSearchParams(location.search);

const renderer = createRenderer(canvas);
const audio = createAudio();

let match: GameMatch | null = null;
let ended = false;
let paused = false;
/**
 * Match clock: every pause (user, missing phone, hidden tab, absorbed long
 * frame) is an interval of host time, and match time leaves out the paused
 * time before it (src/host/timeline.ts).
 */
const timeline = new PauseTimeline();
/**
 * Converts any host time (performance.now) to match time. Every input path
 * goes through this: keyboard now, phone swings at clock.toHost(tp).
 */
const toMatchTime = (hostTime: number) => timeline.toMatchTime(hostTime);
const matchNow = (now: number) => toMatchTime(now);

function setPaused(p: boolean): void {
  const now = performance.now();
  if (p && !paused) timeline.pause(now);
  if (!p && paused) timeline.resume(now);
  paused = p;
}

// ---- Phones ----
const phones = new Map<number, Phone>();
let joinSeq = 0;
/** Who plays the match in progress (null between matches). slots follow `seats`. */
let playing: Assignment | null = null;
/** The match's human players, bound to phone ids (null between matches). */
let seats: Seat[] | null = null;
/** The pause was opened because a playing phone went missing (so its return resumes play). */
let pausedForPhone = false;
/** Pending auto-resume after a phone came back (0: none). */
let resumeTimer = 0;
function cancelResume(): void { clearTimeout(resumeTimer); resumeTimer = 0; }
/** Host time the current wait for a phone began, or null. */
let waitSince: number | null = null;
/** After this long waiting, the pause card offers "Continue with the keyboard". */
const KEYBOARD_OFFER_MS = 60_000;
const changes = new ChangeFilter();
/** Player receiving the ball in the last frame's view: a 'missed' point is theirs. */
let receiverBefore: number | null = null;
/** Players who whiffed the ball in play: their miss is sent when the point is decided (phones.ts eventMessages). */
const whiffed = new Set<number>();

const sendPhone = (m: PhoneMessage) => net.send(m as unknown as Message);
const sendChanged = (m: PhoneMessage) => { if (changes.pass(m)) sendPhone(m); };
const matchLive = () => match !== null && playing !== null && !ended;

function setupAssignment(): Assignment {
  const config = ui.config();
  return assignPlayers(phones.values(), config.mode, config.humans ?? 1);
}
/** The assignment phones are told about: the match in progress, else the setup screen's. */
const currentAssignment = () => (matchLive() ? playing! : setupAssignment());

/** A phone that answered a ping within PONG_TIMEOUT_MS. */
function live(slot: number): boolean {
  const last = net.lastPong.get(slot);
  return phones.get(slot)?.connected === true && last !== undefined && performance.now() - last <= PONG_TIMEOUT_MS;
}

/** Match players the game is waiting for (away, back but motion not ok yet, or silent). */
function missingNow(): number[] {
  return matchLive() && seats ? missingPlayers(seats, live) : [];
}

/** Keep playing.slots (used for every message to the playing phones) in step with the seats. */
function syncPlaying(): void {
  if (playing && seats) playing = { ...playing, slots: seatSlots(seats) };
}

/** Redraw the Players panel and tell every phone its role. */
function refreshLobby(): void {
  const config = ui.config();
  const a = setupAssignment();
  const ordered = byJoinOrder(phones.values());
  const cards: LobbyCard[] = ordered.map((p) => {
    const i = playerOfSlot(a, p.slot);
    return {
      slot: p.slot, name: p.name, color: p.color ?? DEFAULT_COLORS[Math.max(0, i) % 2],
      connected: p.connected, role: i >= 0 ? `Player ${i + 1}` : 'Watching', playing: i >= 0,
    };
  });
  const connected = ordered.filter((p) => p.connected).length;
  let summary: string;
  if (connected === 0) {
    summary = 'No phones yet. Start match still works: Space swings for player 1'
      + (a.humans === 2 ? ', Enter for player 2.' : '.');
  } else {
    const parts = a.slots.map((slot, i) => {
      const phone = slot === null ? undefined : phones.get(slot);
      return phone ? `${shortName(phone.name)} is player ${i + 1}` : `player ${i + 1} uses the keyboard (${i === 0 ? 'Space' : 'Enter'})`;
    });
    const format = config.mode === 'singles' ? 'Singles' : `Doubles, ${a.humans} human${a.humans === 2 ? 's' : ''}`;
    const extra = connected > a.slots.filter((s) => s !== null).length ? ' Other phones watch.' : '';
    summary = `${format}: ${parts.join(', ')}.${extra}`;
  }
  ui.lobby.setPlayers(cards, summary);
  sendYou();
}

function sendYou(): void {
  const a = currentAssignment();
  const { names, colors } = matchIdentity(a, phones);
  for (const m of youMessages(phones.values(), a, names!, colors!)) sendChanged(m);
}

function modeFor(slot: number): PhoneMode {
  return matchLive() && playing!.slots.includes(slot) ? 'play' : 'lobby';
}

function sendModes(slots: Iterable<number | null>, mode: 'lobby' | 'play'): void {
  for (const to of slots) if (to !== null && phones.get(to)?.connected) sendPhone({ t: 'mode', to, mode });
}

function onPhone(slot: number, name: string, state: 'in' | 'out', relayId: string): void {
  const known = phones.get(slot);
  if (state === 'in') {
    // The id is who the phone is: the same id keeps its place in the queue on any slot.
    const id = relayId || `slot-${slot}-${name}`;
    phoneJoined(phones, slot, name, id, () => ++joinSeq);
    changes.forget(slot);
    // A match player's phone is back on this slot (it waits for motion 'ok'); any other id watches.
    if (seats) { seatIn(seats, id, slot); syncPlaying(); }
  } else if (known) {
    known.connected = false;
    known.leftAt = performance.now();
    if (seats) { seatOut(seats, slot); syncPlaying(); }
    // The relay frees a slot after SLOT_HOLD_MS; drop the card then unless it came back.
    setTimeout(pruneExpired, SLOT_HOLD_MS + 500);
  }
  if (!matchLive()) {
    ui.setHumans(suggestedHumans(phones.values()));
  }
  refreshLobby();
  updateWaiting();
}

/** Drop the cards of phones gone longer than the hold; a match player's card stays while its match runs. */
function pruneExpired(): void {
  const keep = (p: Phone) => matchLive() && seats !== null && seats.some((s) => s.id !== null && s.id === p.id);
  const gone = expiredSlots(phones, performance.now(), keep, SLOT_HOLD_MS);
  if (gone.length === 0) return;
  for (const slot of gone) phones.delete(slot);
  refreshLobby();
}

const keysFor = (players: number[]) => players.map((i) => (i === 0 ? 'Space for player 1' : 'Enter for player 2')).join(', ');

/**
 * Pause while a match player is missing (disconnected, silent, or back but
 * motion not ok yet), and resume 1.5 s after every one is back. After
 * KEYBOARD_OFFER_MS the pause card also offers the keyboard.
 */
function updateWaiting(): void {
  const missing = missingNow();
  const screen = ui.screen();
  if (missing.length > 0) {
    cancelResume();
    const now = performance.now();
    if (waitSince === null) waitSince = now;
    const offer = now - waitSince >= KEYBOARD_OFFER_MS ? { keys: keysFor(missing) } : null;
    ui.setWaiting(waitingText(seats!, missing), offer);
    if (screen === 'match') {
      pausedForPhone = true;
      ui.show('pause');
      setPaused(true);
    }
    return;
  }
  waitSince = null;
  ui.setWaiting(null);
  if (pausedForPhone && screen === 'pause' && !document.hidden) {
    // Give the player a moment to pick the phone up again, then play on.
    if (resumeTimer !== 0) return;
    resumeTimer = window.setTimeout(() => {
      resumeTimer = 0;
      if (pausedForPhone && !document.hidden && ui.screen() === 'pause' && missingNow().length === 0) ui.resume();
    }, 1500);
  }
}

// Liveness: a playing phone that stops answering pings (frozen page, locked
// screen with the socket still open) counts as missing after PONG_TIMEOUT_MS.
setInterval(() => { if (!document.hidden) updateWaiting(); }, 500);

function onPhoneMessage(m: Message): void {
  const slot = Number(m.slot);
  if (m.t === 'room') {
    const code = String(m.code);
    ui.lobby.setRoom(code, null);
    fetch('/api/lan').then((r) => r.json()).then((lan: { ips: string[]; port: number }) => {
      ui.lobby.setRoom(code, `https://${lan.ips[0] || location.hostname}:${lan.port}/play/?r=${code}`);
    }).catch(() => ui.lobby.setRoomError('Could not create the phone link. Reload and check the dev server.'));
    return;
  }
  const phone = phones.get(slot);
  if (!phone) return;
  if (m.t === 'status') {
    // A returning match player's phone can swing again: it stops being missing.
    if (m.motion === 'ok' && seats && seatReady(seats, slot) >= 0) updateWaiting();
    return;
  }
  if (m.t === 'player-info') {
    const color = safeColor(m.colour ?? m.color);
    if (color !== phone.color) { phone.color = color; refreshLobby(); }
    return;
  }
  if (m.t === 'swing' && isSwing(m)) {
    const power = Number(m.power);
    ui.lobby.kick(slot, power);
    phoneSwing(slot, Number(m.tp), power, Number(m.spin));
  }
}

function phoneSwing(slot: number, tp: number, power: number, spin: number): void {
  if (!match || !playing || paused || ui.screen() !== 'match') return;
  const player = playerOfSlot(playing, slot);
  if (player < 0 || !match.view().players[player]?.human) return;
  const clock = net.clocks.get(slot);
  // No clock sample yet (just joined): the phone's time cannot be placed, so the swing is dropped.
  if (!clock?.best) return;
  const now = performance.now();
  absorbGap(now);
  const hostTime = Math.min(clock.toHost(tp), now);
  // A swing made while the match was paused (or the page frozen) did not happen in the match.
  if (timeline.inPause(hostTime)) return;
  match.swing({ player, t: toMatchTime(hostTime), power, spin });
}

const net = hostConnection(
  (m) => onPhoneMessage(m),
  (s) => ui.lobby.setRoomError(s),
  { mode: modeFor, onPlayer: onPhone },
);

/** Phones of the match that just ended or was quit go back to the lobby. */
function releasePhones(): void {
  if (!playing) return;
  const slots = playing.slots;
  playing = null;
  seats = null;
  pausedForPhone = false;
  waitSince = null;
  cancelResume();
  ui.setWaiting(null);
  sendModes(slots, 'lobby');
  refreshLobby();
  // Cards kept for the match's players while it ran: drop the ones gone longer than the hold.
  pruneExpired();
}

const ui = createUi(overlay, {
  onUnlock: () => audio.unlock(),
  onStart: (config) => {
    if (playing) releasePhones();
    const a = assignPlayers(phones.values(), config.mode, config.humans ?? 1);
    const full: MatchConfig = { ...config, humans: a.humans, ...matchIdentity(a, phones) };
    match = createMatch(full);
    seats = createSeats(a, phones);
    playing = { ...a, slots: seatSlots(seats) };
    ended = false;
    paused = false;
    pausedForPhone = false;
    waitSince = null;
    timeline.reset();
    receiverBefore = null;
    whiffed.clear();
    smoothing.until = 0;
    for (const slot of a.slots) if (slot !== null) changes.forget(slot);
    sendModes(a.slots, 'play');
    sendYou();
  },
  onPause: (p) => {
    setPaused(p);
    if (!p) { pausedForPhone = false; cancelResume(); }
  },
  onQuit: () => { match = null; paused = false; timeline.reset(); releasePhones(); },
  onKeyboard: () => {
    // "Continue with the keyboard": the missing players are keyboard players
    // until their phone is back with motion 'ok'.
    if (!seats) return;
    takeOverWithKeyboard(seats, missingNow());
    pausedForPhone = false;
    updateWaiting();
    ui.resume();
  },
  onMute: (m) => audio.setMuted(m),
  onSetupChange: () => refreshLobby(),
});

// ---- Keyboard swings (fallback when no phone plays) ----
const held = new Set<string>();
addEventListener('keyup', (e) => held.delete(e.code));
addEventListener('blur', () => held.clear());
addEventListener('keydown', (e) => {
  held.add(e.code);
  if (e.repeat || !match || paused || ui.screen() !== 'match') return;
  const player = e.code === 'Space' ? 0 : e.code === 'Enter' || e.code === 'NumpadEnter' ? 1 : -1;
  if (player < 0 || !match.view().players[player]?.human) return;
  e.preventDefault();
  const spin = held.has('KeyW') ? 0.8 : held.has('KeyS') ? -0.8 : 0;
  // A key handled right after a freeze, before the next frame, must not be dated in the future.
  const now = performance.now();
  absorbGap(now);
  match.swing({ player, t: toMatchTime(now), power: 0.7, spin });
});

// ---- Ball smoothing ----
// A late phone swing re-launches the ball from where it really was, which can
// be a metre or more from where it was drawn. Draw the difference away over
// SMOOTH_MS instead of jumping (DESIGN.md section 5, lag compensation).
const SMOOTH_MS = 120;
const smoothing = { from: { x: 0, y: 0, z: 0 } as Vec3, start: 0, until: 0 };
const drawn: Vec3 = { x: 0, y: 0, z: 0 };
function smoothBall(view: MatchView, events: MatchEvent[], now: number): MatchView {
  if (events.some((e) => e.type === 'hit')) {
    smoothing.from = { x: drawn.x - view.ball.pos.x, y: drawn.y - view.ball.pos.y, z: drawn.z - view.ball.pos.z };
    smoothing.start = now;
    smoothing.until = now + SMOOTH_MS;
  }
  let pos = view.ball.pos;
  if (now < smoothing.until) {
    const k = 1 - (now - smoothing.start) / SMOOTH_MS;
    const ease = k * k;
    pos = { x: pos.x + smoothing.from.x * ease, y: pos.y + smoothing.from.y * ease, z: pos.z + smoothing.from.z * ease };
  }
  drawn.x = pos.x; drawn.y = pos.y; drawn.z = pos.z;
  return pos === view.ball.pos ? view : { ...view, ball: { ...view.ball, pos } };
}

// ---- Hidden tab and long frames ----
// Browsers stop drawing a hidden tab; without this the match would catch up
// the whole gap on return and the CPU would win points nobody saw.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // A pending auto-resume must not fire in a tab nobody sees. It is only
    // cancelled, not forgotten: once the tab is visible again and the phone is
    // ready, the liveness check starts the 1.5 s resume again (DESIGN.md section 3).
    cancelResume();
    if (match && ui.screen() === 'match') { ui.show('pause'); setPaused(true); }
  } else {
    // Pings stall in a hidden tab: do not count the phones as silent for it.
    net.touch();
  }
});
/** A frame gap longer than this is treated as a pause, not as play. */
const MAX_FRAME_GAP_MS = 250;
let lastFrame = performance.now();

// ---- Frame loop ----
const NO_EVENTS: MatchEvent[] = [];
/** Treats the part of a long gap (page frozen, tab throttled) beyond MAX_FRAME_GAP_MS as paused time. */
function absorbGap(now: number): void {
  const gap = now - lastFrame;
  lastFrame = now;
  if (match && !paused && gap > MAX_FRAME_GAP_MS) timeline.add(now - gap + MAX_FRAME_GAP_MS, now);
}

/** hit, miss and game messages for the playing phones. */
function feedPhones(view: MatchView, events: MatchEvent[]): void {
  if (!playing) return;
  for (const m of eventMessages(events, playing, receiverBefore, whiffed)) sendPhone(m);
  for (const m of gameMessages(view, playing, paused)) sendChanged(m);
  receiverBefore = view.players.find((p) => p.receiving)?.id ?? null;
}

function frame(now: number): void {
  absorbGap(now);
  const screen = ui.screen();
  if (match && (screen === 'match' || screen === 'pause' || screen === 'end')) {
    const t = matchNow(now);
    const events = paused ? NO_EVENTS : match.update(t);
    const view = smoothBall(match.view(), events, t);
    renderer.render(view, t);
    if (screen !== 'end') ui.update(view);
    if (screen === 'match') audio.play(events, view);
    feedPhones(view, events);
    if (view.phase === 'match-over' && !ended) {
      ended = true;
      // Let the final point's message and crowd play before the end screen.
      const finished = match;
      setTimeout(() => {
        if (match !== finished) return;
        ui.end(finished.view());
        releasePhones();
      }, 1800);
    }
  } else {
    // Backdrop: the stub rally behind the title and setup screens.
    const frozen = params.has('t') ? Number(params.get('t')) : null;
    const t = frozen ?? now;
    renderer.render(stubView(t), t);
  }
  requestAnimationFrame(frame);
}

addEventListener('resize', () => renderer.resize());

if (import.meta.env.DEV) {
  // Lets the browser test drive and inspect the match.
  (window as unknown as { __rally: unknown }).__rally = {
    get match() { return match; },
    matchNow: () => matchNow(performance.now()),
    get playing() { return playing; },
    get phones() { return [...phones.values()]; },
    get paused() { return paused; },
    get seats() { return seats; },
  };
}

const start = params.get('screen');
if (start === 'setup') ui.show('setup');
refreshLobby();
requestAnimationFrame(frame);
