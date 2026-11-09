// Phone controller: join, allow motion, lobby swing test, and the racket face during play.
// Protocol: docs/DESIGN.md section 3 ("Phase 3 messages").
import '../styles/phone.css';
import type { RawSample, WireMessage } from '../shared/protocol';
import { Link, type LinkState } from './net';
import { Motion } from './motion';
import { RacketFace } from './racket';
import {
  SWEET_SPOT_A, asGameState, asMode, hapticPattern, isYourMove, mergeYou, pidFor, promptFor, screenFor, spinWord,
  type GameState, type PhoneMode, type Screen, type You,
} from './logic';

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
  chosen = { hand: String(data.get('hand') || 'Right'), colour: String(data.get('colour') || '#0F4C5C') };
  for (const face of [playFace, lobbyFace]) face.setLeftHanded(chosen.hand === 'Left');
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ name, ...chosen })); } catch { /* private mode */ }
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
    if (mode !== 'lab') return;
    batch.push(sample);
    if (batch.length >= 4) { link.send({ t: 'raw', s: batch }); batch = []; }
  },
  swing(swing) {
    link.send({ ...swing });
    link.send({ t: 'profile', ...motion.detector.report() });
    if (screen !== 'lobby') return;
    const power = swing.power;
    $<HTMLMeterElement>('power').value = power;
    $('power-value').textContent = `${Math.round(power * 100)}%`;
    $('spin-word').textContent = spinWord(swing.spin);
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

applyColour();
show('join');
