// Pure helpers for the phone controller: no DOM, unit tested in tests/phone/logic.test.ts.

export type GameState = 'wait' | 'serve' | 'toss' | 'rally' | 'paused' | 'over';
export type Screen = 'join' | 'allow' | 'lobby' | 'play' | 'gone';
export type PhoneMode = 'lobby' | 'play' | 'lab';

const GAME_STATES: readonly GameState[] = ['wait', 'serve', 'toss', 'rally', 'paused', 'over'];

export function asGameState(value: unknown): GameState | null {
  return typeof value === 'string' && (GAME_STATES as readonly string[]).includes(value) ? value as GameState : null;
}

/** The prompt line on the racket face, from the host's `game.state` (DESIGN.md section 3). */
export function promptFor(state: GameState | null): string {
  switch (state) {
    case 'serve': return 'Your serve: swing to toss';
    case 'toss': return 'Swing to hit';
    case 'rally': return 'Rally';
    case 'wait': return 'Get ready';
    case 'paused': return 'Paused';
    case 'over': return 'Match over';
    default: return 'Get ready';
  }
}

/** True when the player is the one who must act now: the prompt is drawn as a call to action. */
export function isYourMove(state: GameState | null): boolean {
  return state === 'serve' || state === 'toss';
}

/** Mode from the host. Older hosts send `serve` or `rally`, which both mean the racket face. */
export function asMode(value: unknown): PhoneMode | null {
  if (value === 'lab' || value === 'lobby' || value === 'play') return value;
  if (value === 'serve' || value === 'rally') return 'play';
  return null;
}

/** Which screen to show once joined. Motion must be allowed first: it needs a tap on iOS. */
export function screenFor(mode: PhoneMode, motionReady: boolean): Screen {
  if (!motionReady) return 'allow';
  return mode === 'play' ? 'play' : 'lobby';
}

/** What the phone knows about its role, from the host's `you` messages. */
export interface You { player?: number; color?: string; team?: string }

/**
 * Applies a `you` message. A key that is present and null clears the value
 * (the phone is now watching: no player number, no team); a key that is
 * absent or not valid keeps the old value.
 */
export function mergeYou(prev: You, m: Record<string, unknown>): You {
  const pick = <K extends keyof You>(key: K, valid: (v: unknown) => You[K] | undefined): You[K] => {
    if (!(key in m)) return prev[key];
    if (m[key] === null) return undefined;
    return valid(m[key]) ?? prev[key];
  };
  return {
    player: pick('player', (v) => (typeof v === 'number' ? v : undefined)),
    color: pick('color', (v) => (typeof v === 'string' && /^#[0-9a-f]{3,6}$/i.test(v) ? v : undefined)),
    team: pick('team', (v) => (typeof v === 'string' ? v.slice(0, 24) : undefined)),
  };
}

/** localStorage key of the phone's id for one room. */
export function pidKey(room: string): string {
  return `rally-room-pid-${room.toUpperCase()}`;
}

/**
 * The phone's id for a room: kept in localStorage per room code, so a re-scan
 * of the QR or a new tab joins as the same player (DESIGN.md section 3).
 */
export function pidFor(
  room: string,
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void },
  make: () => string,
): string {
  try {
    const saved = storage.getItem(pidKey(room));
    if (saved && saved.length <= 128) return saved;
  } catch { /* storage blocked: a fresh id */ }
  const pid = make();
  try { storage.setItem(pidKey(room), pid); } catch { /* private mode: this page keeps it in memory */ }
  return pid;
}

export function spinWord(spin: number): 'Topspin' | 'Slice' | 'Flat' {
  return spin > 0.2 ? 'Topspin' : spin < -0.2 ? 'Slice' : 'Flat';
}

/**
 * Vibration pattern for a hit, by quality. A clean hit is one firm buzz, longer when cleaner;
 * a mishit rattles like a ball off the frame.
 */
export function hapticPattern(quality: number): number[] {
  const q = clamp01(quality);
  if (q >= 0.55) return [Math.round(25 + 55 * q)];
  return [14, 30, 14];
}

/** Reconnect delay for attempt n (0 based): 0.5 s doubling to a 4 s ceiling. */
export function backoffDelay(attempt: number): number {
  return Math.min(4000, 500 * 2 ** Math.max(0, attempt));
}

/** Ripple shape from hit quality: cleaner hits travel further, ring wider and brighter. */
export function rippleStyle(quality: number) {
  const q = clamp01(quality);
  return {
    duration: 650 + 550 * q,
    amplitude: 2.5 + 7.5 * q,
    reach: 0.55 + 0.75 * q,
    ring: 3 + 11 * q,
    alpha: 0.6 + 0.4 * q,
    clean: q >= 0.55,
  };
}

/** A hit near the frame: reads as a mishit (DESIGN.md section 1). */
export function nearFrame(u: number, v: number): boolean {
  return Math.hypot(u, v) > 0.8 || Math.abs(u) > 0.85 || Math.abs(v) > 0.85;
}

export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

// Colour

export type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const s = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as Rgb;
}

export function toHex(rgb: Rgb): string {
  return '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');
}

export function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as Rgb;
}

/**
 * The team colour pushed toward `toward` until it reaches `min` contrast against `against`.
 * Keeps the hue recognisable while staying readable (strings on the dark string bed).
 */
export function readableOn(colour: string, against: string, min: number, toward = '#F3E9D2'): string {
  const c = parseHex(colour), bg = parseHex(against), to = parseHex(toward);
  if (!c || !bg || !to) return toward;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const candidate = mix(c, to, t);
    if (contrast(candidate, bg) >= min) return toHex(candidate);
  }
  return toward;
}
