// Phone controller: join, allow motion, lobby swing test, and the racket face during play.
// Protocol: docs/DESIGN.md section 3 ("Phase 3 messages").
import '../styles/phone.css';
import type { RawSample, WireMessage } from '../shared/protocol';
import { Link, type LinkState } from './net';
import { Motion } from './motion';
import { RacketFace } from './racket';
import {
  SWEET_SPOT_A, asGameState, asMode, hapticPattern, isYourMove, mergeYou, pidFor, promptFor,
  calibrationForJoin, sameKey, saveCalibration, screenFor, spinWord, stepName, teachAvailable,
  type GameState, type PhoneMode, type Screen, type You,
} from './logic';
import { STEPS, SWINGS_PER_STEP, Teacher, handSide, isCalibrated } from '../shared/calibration';
import { wireSwing } from '../shared/swing';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const PREFS_KEY = 'rally-room-player-v1';

// Session

// One id per room code, kept in localStorage: a reload, a re-scan of the QR or a new tab joins as
// the same player. (A second tab with the same id takes over; the old tab is told 'rejoined'.)
const pids = new Map<string, string>();
const storage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
};
function pidOf(room: string): string {
  let pid = pids.get(room);
  if (!pid) { pid = pidFor(room, storage, () => crypto.randomUUID()); pids.set(room, pid); }
  return pid;
}

let screen: Screen = 'join';
let mode: PhoneMode = 'lobby';
let motionAsked = false;
let motionStatus: 'ok' | 'denied' | 'none' | undefined;
let game: { state: GameState | null; score: string } = { state: null, score: '' };
let you: You = {};
let chosen = { hand: 'Right', colour: '#0F4C5C' };
let batch: RawSample[] = [];
let missTimer: ReturnType<typeof setTimeout> | undefined;
let countdown: ReturnType<typeof setInterval> | undefined;
/** The joined player's name: spin calibrations are kept per name on this phone. */
let playerName = '';
/** The spin teaching flow while it runs (lobby only), and whether its result is showing. */
let teacher: Teacher | null = null;
let teachShowingResult = false;
/** The detector's sensor mode as last rendered, so the teach card follows it (gyro or not). */
let lastSensorMode = 'starting';

const playFace = new RacketFace($<HTMLCanvasElement>('play-racket'), { aspect: 0.62 });
const lobbyFace = new RacketFace($<HTMLCanvasElement>('lobby-racket'));

// Screens

function show(next: Screen) {
  screen = next;
  for (const id of ['join', 'allow', 'lobby', 'play', 'gone'] as const) $(`screen-${id}`).hidden = id !== next;
  document.body.dataset.screen = next;
  if (next === 'lobby') renderLobby();
  if (next === 'play') renderHud();
}

function route() {
  if (link.state.kind !== 'joined') return;
  show(screenFor(mode, motionStatus === 'ok'));
}

function teamColour() { return you.color ?? chosen.colour; }

function applyColour() {
  const colour = teamColour();
  document.documentElement.style.setProperty('--team', colour);
  playFace.setColour(colour);
  lobbyFace.setColour(colour);
  const label = you.player ? String(you.player) : '';
  playFace.setLabel(label);
  lobbyFace.setLabel(label);
}

function renderLobby() {
  const lab = mode === 'lab';
  $('lobby-kicker').textContent = lab ? 'Sensor lab' : you.player ? `You are player ${you.player}` : 'You are in';
  $('lobby-team-name').textContent = you.team ?? 'Your racket';
  $('lobby-status').textContent = lab ? 'Streaming motion to the sensor lab' : 'Waiting for the host to start';
  renderTeach();
}

function renderHud() {
  $('score').textContent = game.score;
  if (missTimer) return;
  const prompt = $('prompt');
  prompt.textContent = promptFor(game.state);
  prompt.classList.toggle('act', isYourMove(game.state));
  prompt.classList.toggle('quiet', game.state === 'rally');
}

function wakeNote(awake: boolean) {
  const text = awake ? 'The screen stays on while this page is open.'
    : 'If the screen locks during play, turn off auto-lock in your phone settings.';
  $('lobby-wake').textContent = text;
}

// Join

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    if (p && typeof p === 'object') {
      if (typeof p.name === 'string') $<HTMLInputElement>('name').value = p.name;
      const hand = document.querySelector<HTMLInputElement>(`input[name=hand][value="${p.hand === 'Left' ? 'Left' : 'Right'}"]`);
      if (hand) hand.checked = true;
      const colour = [...document.querySelectorAll<HTMLInputElement>('input[name=colour]')].find((i) => i.value === p.colour);
      if (colour) colour.checked = true;
    }
  } catch { /* no saved player yet */ }
}

const roomInput = $<HTMLInputElement>('room');
roomInput.value = (new URLSearchParams(location.search).get('r') || '').toUpperCase().slice(0, 4);
roomInput.addEventListener('input', () => { roomInput.value = roomInput.value.toUpperCase(); });
loadPrefs();
if (roomInput.value) $('room-hint').textContent = 'Filled in from the link you opened.';

const joinButton = $<HTMLButtonElement>('join-button');
function joinPending(pending: boolean) {
  joinButton.disabled = pending;
  joinButton.textContent = pending ? 'Joining…' : 'Join the game';
  joinButton.setAttribute('aria-busy', String(pending));
}

const JOIN_ERRORS: Record<string, string> = {
  'no-room': 'No game with that code. Check the four letters on the game screen.',
  full: 'That game already has four phones.',
  'invalid-join': 'Enter a name of up to 30 letters.',
  network: 'Could not reach the game. Make sure this phone is on the same Wi-Fi as the game screen.',
};

$<HTMLFormElement>('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const name = String(data.get('name') || '').trim();
  const handChanged = String(data.get('hand') || 'Right') !== chosen.hand;
  chosen = { hand: String(data.get('hand') || 'Right'), colour: String(data.get('colour') || '#0F4C5C') };
  for (const face of [playFace, lobbyFace]) face.setLeftHanded(chosen.hand === 'Left');
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ name, ...chosen })); } catch { /* private mode */ }
  // Each player's own spin calibration on this phone; another name starts on the fixed rule. The same
  // player rejoining keeps the calibration in memory (it may not have been savable), and teaching is
  // cancelled only for another player or another hand (the steps expect the turn direction of the hand).
  if (!sameKey(name, playerName) || handChanged) { stopTeach(); teachShowingResult = false; }
  motion.detector.calibration = calibrationForJoin(playerName, name, motion.detector.calibration, storage);
  playerName = name;
  $('join-error').hidden = true;
  joinPending(true);
  const room = roomInput.value.toUpperCase();
  link.join(room, name, pidOf(room));
});

// Link

const link = new Link(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, {
  state: onLinkState,
  message: onMessage,
  joinError(reason) {
    joinPending(false);
    const error = $('join-error');
    error.textContent = JOIN_ERRORS[reason] ?? `Could not join (${reason}).`;
    error.hidden = false;
  },
});

function onLinkState(state: LinkState) {
  const overlay = $('reconnect');
  if (state.kind !== 'reconnecting') { overlay.hidden = true; stopCountdown(); }
  switch (state.kind) {
    case 'joined':
      joinPending(false);
      link.send({ t: 'player-info', hand: chosen.hand, colour: chosen.colour });
      if (motionStatus) link.send(statusMessage());
      if (!state.rejoin) { applyColour(); $('allow-kicker').textContent = `Joined room ${roomInput.value.toUpperCase()}`; }
      route();
      break;
    case 'reconnecting':
      overlay.hidden = false;
      startCountdown(state.until, state.attempt);
      break;
    case 'lost':
      endScreen(state.reason === 'replaced'
        ? ['This racket moved to another tab.', 'The game is now talking to the other tab. Close this one, or join again here to take it back.', false]
        : state.reason === 'full'
          ? ['Your place was taken.', 'The game filled up while this phone was away. Join again when a place is free.', false]
          : ['Could not reconnect.', 'The game held your place for 60 seconds. Check the Wi-Fi and try again.', true]);
      break;
    case 'gone':
      endScreen(['The game has closed.', 'The host left. When a new game starts, enter its room code to join.', false]);
      break;
    default:
      break;
  }
}

function endScreen([title, text, canRetry]: [string, string, boolean]) {
  $('gone-title').textContent = title;
  $('gone-text').textContent = text;
  $('gone-retry').hidden = !canRetry;
  batch = [];
  show('gone');
}

$('gone-retry').addEventListener('click', () => link.retry());
$('gone-join').addEventListener('click', () => {
  link.close();
  you = {};
  game = { state: null, score: '' };
  mode = 'lobby';
  applyColour();
  show('join');
  roomInput.select();
});

function startCountdown(until: number, attempt: number) {
  stopCountdown();
  const tick = () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    $('reconnect-text').textContent = `Your place is held for ${left} more seconds. Attempt ${attempt}.`;
  };
  tick();
  countdown = setInterval(tick, 1000);
}
function stopCountdown() { if (countdown) clearInterval(countdown); countdown = undefined; }

function onMessage(m: WireMessage) {
  switch (m.t) {
    case 'ping':
      link.send({ t: 'pong', h: m.h, p: performance.now() });
      break;
    case 'mode': {
      const next = asMode(m.mode);
      if (!next) break;
      mode = next;
      batch = [];
      // Teaching only runs in the lobby: a match or the lab ends it unsaved.
      if (mode !== 'lobby') { stopTeach(); teachShowingResult = false; }
      if (screen === 'lobby' || screen === 'play') route();
      break;
    }
    case 'you':
      // player: null and team: null mean "watching": clear them, and the racket loses its number.
      you = mergeYou(you, m);
      applyColour();
      renderLobby();
      break;
    case 'game':
      game = {
        state: asGameState(m.state) ?? game.state,
        score: typeof m.score === 'string' ? m.score.slice(0, 40) : game.score,
      };
      renderHud();
      break;
    case 'hit': {
      // u = a along the racket, v = b across it: where the ball really met the face (DESIGN.md section 3).
      const q = Number(m.quality), a = Number(m.u), b = Number(m.v), frame = m.frame === true;
      (screen === 'lobby' ? lobbyFace : playFace).hit(a, b, q, frame);
      buzz(hapticPattern(frame ? 0 : q));
      break;
    }
    case 'miss':
      playFace.miss();
      shake();
      flashPrompt('Missed');
      break;
    default:
      break;
  }
}

function buzz(pattern: number[]) {
  try { if ('vibrate' in navigator) navigator.vibrate(pattern); } catch { /* not allowed here */ }
}

function shake() {
  const face = $('face');
  face.classList.remove('shake');
  void face.offsetWidth;
  face.classList.add('shake');
}

function flashPrompt(text: string) {
  const prompt = $('prompt');
  if (missTimer) clearTimeout(missTimer);
  prompt.textContent = text;
  prompt.classList.remove('act', 'quiet');
  prompt.classList.add('miss');
  missTimer = setTimeout(() => { missTimer = undefined; prompt.classList.remove('miss'); renderHud(); }, 1200);
}

// Motion

const statusMessage = () => ({ t: 'status', motion: motionStatus ?? 'none', wake: motion.awake });

const motion = new Motion({
  ready() {
    motionStatus = 'ok';
    link.send(statusMessage());
    allowPending(false);
    route();
  },
  silent() {
    motionStatus = 'none';
    link.send(statusMessage());
    allowPending(false, 'Try again');
    $('allow-message').textContent = 'No motion data arrived. Check that motion sensors are allowed for this browser, or try another browser.';
  },
  raw(sample) {
    // The teach card needs a gyroscope: show or hide it as soon as the sensor mode is known.
    if (motion.detector.sensorMode !== lastSensorMode) { lastSensorMode = motion.detector.sensorMode; renderTeach(); }
    if (mode !== 'lab') return;
    batch.push(sample);
    if (batch.length >= 4) { link.send({ t: 'raw', s: batch }); batch = []; }
  },
  swing(swing) {
    link.send({ ...wireSwing(swing) });
    link.send({ t: 'profile', ...motion.detector.report() });
    if (screen !== 'lobby') return;
    const power = swing.power;
    $<HTMLMeterElement>('power').value = power;
    $('power-value').textContent = `${Math.round(power * 100)}%`;
    $('spin-word').textContent = teacher ? 'Learning' : spinWord(swing.spin);
    if (teacher && mode === 'lobby') {
      // Only swings the expected way round count; a follow-through the other way is ignored.
      if (teacher.add(swing.dir, swing.path, swing.face)) {
        if (teacher.done) finishTeach();
        else renderTeach();
      }
    }
    // Practice swings have no ball: the ripple starts at the sweet spot, nudged toward the top edge for topspin.
    lobbyFace.hit(SWEET_SPOT_A, swing.spin * 0.5, 0.35 + 0.65 * power);
  },
  learned(report) {
    link.send({ t: 'profile', ...report });
  },
});

const allowButton = $<HTMLButtonElement>('allow');
function allowPending(pending: boolean, label = 'Allow motion') {
  allowButton.disabled = pending;
  allowButton.setAttribute('aria-busy', String(pending));
  allowButton.textContent = pending ? 'Starting sensors…' : label;
}

allowButton.addEventListener('click', async () => {
  motionAsked = true;
  allowPending(true);
  $('allow-message').textContent = '';
  const result = await motion.allow();
  if (!result.ok) {
    motionStatus = result.status;
    link.send(statusMessage());
    $('allow-message').textContent = result.message;
    allowPending(false, 'Try again');
    return;
  }
  $('allow-message').textContent = 'Waiting for sensor data…';
  wakeNote(await motion.keepAwake());
  if (motionStatus === 'ok') link.send(statusMessage());
  if (motion.ready && motionStatus !== 'ok') { motionStatus = 'ok'; link.send(statusMessage()); allowPending(false); route(); }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && motionAsked) void motion.keepAwake().then(wakeNote);
});

// Spin calibration (DESIGN.md section 4): optional, lobby only, kept per player name on this phone.

function renderTeach() {
  const card = $('teach');
  card.hidden = !teachAvailable(mode, motion.detector.sensorMode);
  document.body.dataset.teach = card.hidden ? 'off' : teacher ? 'step' : teachShowingResult ? 'done' : 'idle';
  if (card.hidden) return;
  const view = document.body.dataset.teach;
  $('teach-idle').hidden = view !== 'idle';
  $('teach-step').hidden = view !== 'step';
  $('teach-done').hidden = view !== 'done';
  if (view === 'idle') {
    const calibrated = isCalibrated(motion.detector.calibration);
    card.dataset.calibrated = String(calibrated);
    $('teach-heading').textContent = calibrated ? `Spin taught for ${playerName}` : 'Teach your racket your spin';
    $('teach-state').textContent = calibrated ? 'calibrated' : 'automatic';
    $('teach-hint').textContent = calibrated ? '' : ' \u00b7 18 swings, about a minute';
    $('teach-start').textContent = calibrated ? 'Recalibrate' : 'Teach your racket';
  }
  if (view === 'step' && teacher?.current) {
    const { side, kind } = teacher.current;
    const count = teacher.count;
    $('teach-count').textContent = `Step ${teacher.step + 1} of ${STEPS.length}`;
    $('teach-title').textContent = stepName(side, kind);
    $('teach-progress').textContent = count === 0
      ? `Swing ${SWINGS_PER_STEP} times`
      : `${count} of ${SWINGS_PER_STEP} swings`;
    $('teach').querySelectorAll('.dots > span').forEach((dot, i) => dot.classList.toggle('on', i < count));
    const redo = $<HTMLButtonElement>('teach-redo');
    redo.textContent = teacher.redoLabel;
    redo.disabled = !teacher.canRedo;
  }
}

function startTeach() {
  teacher = new Teacher(chosen.hand === 'Left');
  teachShowingResult = false;
  $('spin-word').textContent = 'Learning';
  renderTeach();
  $('teach-title').focus();
}

function stopTeach() {
  if (!teacher) return;
  teacher = null;
  $('spin-word').textContent = 'swing to see';
}

function finishTeach() {
  if (!teacher) return;
  const fresh = teacher.result();
  const old = motion.detector.calibration;
  teacher = null;
  // A side whose swings were too alike keeps what it had before.
  const cal = { ...fresh, fh: fresh.fh ?? old?.fh ?? null, bh: fresh.bh ?? old?.bh ?? null };
  let title: string, note: string;
  if (fresh.fh && fresh.bh) {
    title = `Spin calibrated for ${playerName}`;
    note = 'Your next swing uses it.';
  } else if (fresh.fh || fresh.bh) {
    // fresh.fh and fresh.bh are physical sides; a left-hander's forehand turns the other way.
    const goodSide = fresh.fh ? 'fh' : 'bh';
    const forehand = handSide(goodSide, chosen.hand === 'Left') === 'fh';
    const good = forehand ? 'Forehand' : 'Backhand', weak = forehand ? 'backhand' : 'forehand';
    title = `${good} spin calibrated for ${playerName}`;
    note = `Your ${weak} swings were too alike to tell apart, so the ${weak} stays as it was.`;
  } else {
    title = 'Spin stays as it was';
    note = 'The three kinds of swing were too alike to tell apart. Try again and make each one clearly different.';
  }
  if (isCalibrated(cal)) {
    motion.detector.calibration = cal;
    if (!saveCalibration(playerName, cal, storage)) note += ' This browser cannot save it, so it lasts until you close the page.';
    link.send({ t: 'profile', ...motion.detector.report() });
  }
  teachShowingResult = true;
  $('teach-result').textContent = title;
  $('teach-result-note').textContent = note;
  $('spin-word').textContent = 'swing to see';
  renderTeach();
  $('teach-result').focus();
}

$('teach-start').addEventListener('click', startTeach);
$('teach-redo').addEventListener('click', () => { teacher?.redo(); renderTeach(); });
$('teach-skip').addEventListener('click', () => { stopTeach(); renderTeach(); $('teach-start').focus(); });
$('teach-ok').addEventListener('click', () => { teachShowingResult = false; renderTeach(); $('teach-start').focus(); });

applyColour();
show('join');
