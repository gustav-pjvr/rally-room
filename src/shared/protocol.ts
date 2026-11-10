// Wire protocol v2: message types, limits and validators shared by the clients and the relay.
// The full description is docs/v2/PROTOCOL.md; keep the two in step.

export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const SLOT_COUNT = 4;
export const SLOT_HOLD_MS = 60_000;
/** The relay pings every socket this often and closes one that did not answer the last ping. */
export const RELAY_HEARTBEAT_MS = 10_000;
/** The only message types a phone may send; the relay drops anything else from a phone. */
export const PHONE_TYPES: readonly string[] = ['swing', 'trace', 'raw', 'status', 'pong', 'player-info', 'profile'];

/** A room created through `/ws/host` is kept this long after its host socket closes, so the host can resume it. */
export const HOST_HOLD_MS = 30_000;
/** A socket that is not a host or a player this long after it opened (or after it lost its place) is closed. */
export const HANDSHAKE_MS = 10_000;
/** A socket the relay has heard nothing from (no message, no pong, no `hb`) for this long is closed. */
export const IDLE_MS = 25_000;
/** Clients that cannot answer protocol pings (the Cloudflare adapter never sends them) send `{"t":"hb"}` this often. */
export const CLIENT_HEARTBEAT_MS = 10_000;
/** The exact keepalive frame; the relay answers it with the same text. */
export const HEARTBEAT_FRAME = '{"t":"hb"}';

/** The largest frame either adapter accepts. A bigger frame closes the socket with CLOSE_CODES.tooBig. */
export const MAX_FRAME_BYTES = 16 * 1024;
/** Per-type caps on a whole frame in UTF-8 bytes. A frame over its cap is dropped with `{t:'error', reason:'too-big'}`. */
export const PHONE_MESSAGE_BYTES: Readonly<Record<string, number>> = {
  swing: 512,
  trace: 10 * 1024,
  raw: 2048,
  status: 256,
  pong: 256,
  'player-info': 256,
  profile: 1024,
};
/** Cap on `host`, `join` and `hb` frames from anyone. */
export const CONTROL_MESSAGE_BYTES = 512;
/** Cap on a host message to a phone. */
export const HOST_MESSAGE_BYTES = 4096;

/** Token buckets per socket: `burst` messages or bytes at once, `rate` per second sustained. */
export interface RateLimit { burst: number; rate: number }
export const RATE_LIMITS = {
  phoneMessages: { burst: 80, rate: 40 },
  phoneBytes: { burst: 128 * 1024, rate: 64 * 1024 },
  hostMessages: { burst: 120, rate: 60 },
  hostBytes: { burst: 128 * 1024, rate: 64 * 1024 },
} as const satisfies Record<string, RateLimit>;
/** Every dropped or malformed frame is a strike; strikes decay at `decayPerS`; past `close` the socket is closed. */
export const STRIKES = { close: 40, decayPerS: 2 } as const;
/** Failed `join` or resume attempts one socket may make; the last one closes it. */
export const MAX_FAILED_JOINS = 5;
/** Failed attempts (no room, bad key) one address may make before new attempts are refused; they decay at `decayPerS`. */
export const ADDRESS_FAILURES = { limit: 30, decayPerS: 0.5 } as const;
/** Rooms one relay instance holds at most (the Node adapter; a Durable Object holds exactly one). */
export const MAX_ROOMS = 256;
/** Rooms one address may host at once on one instance (a laptop with a lab tab, a game tab and reloads). */
export const MAX_ROOMS_PER_ADDRESS = 8;

export const NAME_MAX = 40;
export const PID_MAX = 128;

/** Message types only the relay may send. A phone or host that sends one has it dropped. */
export const RELAY_TYPES: readonly string[] = ['room', 'joined', 'error', 'player', 'host-gone', 'host-away', 'host-back', 'hb'];

export const CLOSE_CODES = {
  /** Policy: too many failed joins, too many strikes, a wrong endpoint. */
  policy: 1008,
  /** A frame over MAX_FRAME_BYTES. */
  tooBig: 1009,
  /** No handshake in time, or nothing heard for IDLE_MS. */
  idle: 4000,
  /** The room closed (host gone after the hold). */
  roomClosed: 4001,
  /** Replaced by a newer host socket that resumed the room. */
  replaced: 4002,
} as const;

export type ErrorReason =
  | 'invalid-message' | 'invalid-join' | 'no-room' | 'full' | 'busy' | 'already-connected'
  | 'rejoined' | 'replaced' | 'bad-key' | 'too-big' | 'too-many-attempts' | 'wrong-endpoint';

/** Phone screen modes. 'serve' and 'rally' are the old Phase 1 names and are read as 'play'. */
export type Mode = 'lobby' | 'play' | 'lab' | 'serve' | 'rally';
export type GameState = 'wait' | 'serve' | 'toss' | 'rally' | 'paused' | 'over';
export type MotionStatus = 'ok' | 'denied' | 'none';
export type RawSample = [number, number, number, number, number, number, number, number, number, number];
export interface Swing {
  tp: number;
  power: number;
  omega: number;
  spin: number;
  dir: number;
  dur: number;
}
export type PhoneMessage =
  | ({ t: 'swing' } & Swing)
  | { t: 'trace'; [key: string]: unknown }
  | { t: 'raw'; s: RawSample[] }
  | { t: 'status'; motion: MotionStatus; wake: boolean; handedness?: string; colour?: string }
  | { t: 'pong'; h: number; p: number }
  | { t: 'player-info'; hand: string; colour: string }
  | { t: 'profile'; [key: string]: unknown };
export type HostMessage =
  | { t: 'ping'; h: number; to: number }
  | { t: 'mode'; mode: Mode; to: number }
  // u = a along the racket (-1 throat .. +1 tip), v = b across it (-1 bottom .. +1 top), up to 1.25 on the frame
  | { t: 'hit'; to: number; quality: number; u: number; v: number; frame?: boolean }
  // Phase 3 (DESIGN.md section 3, Phase 3 messages)
  | { t: 'you'; to: number; player: 1 | 2 | null; color: string; team: string | null }
  | { t: 'game'; to: number; state: GameState; score: string; message: string | null }
  | { t: 'miss'; to: number };
/** Relay messages (docs/v2/PROTOCOL.md). */
export type RelayMessage =
  | { t: 'room'; code: string; key: string; resumed?: boolean }
  | { t: 'joined'; slot: number }
  | { t: 'player'; slot: number; name: string; state: 'in' | 'out'; id: string }
  | { t: 'error'; reason: ErrorReason }
  | { t: 'host-gone' } | { t: 'host-away' } | { t: 'host-back' } | { t: 'hb' };
export interface WireMessage {
  t: string;
  [key: string]: unknown;
}

/** The relay endpoints. `/ws` is the v1 endpoint, kept on the Node adapter only until the clients move. */
export const RELAY_PATHS = { legacy: '/ws', host: '/ws/host', room: '/ws/room/' } as const;

/** URL path a client opens: a new room for a host, or the room's own path for a phone or a resuming host. */
export function relayPath(target: { create: true } | { room: string }): string {
  return 'create' in target ? RELAY_PATHS.host : RELAY_PATHS.room + encodeURIComponent(target.room.toUpperCase());
}

const CODE_RE = new RegExp(`^[${ROOM_ALPHABET}]{4}$`);
export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_RE.test(value);
}

export function parseMessage(data: string): WireMessage | null {
  try {
    const value: unknown = JSON.parse(data);
    if (value && typeof value === 'object' && !Array.isArray(value)
      && 't' in value && typeof value.t === 'string') return value as WireMessage;
  } catch { /* Ignore malformed input without interrupting the connection. */ }
  return null;
}

export function isRawSample(value: unknown): value is RawSample {
  return Array.isArray(value) && value.length === 10
    && value.every((part) => typeof part === 'number' && Number.isFinite(part));
}

export function isSwing(value: WireMessage): value is WireMessage & Swing {
  return ['tp', 'power', 'omega', 'spin', 'dir', 'dur'].every(
    (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
  );
}

/** UTF-8 length of a string, stopping early once it passes `limit`. */
export function utf8Length(text: string, limit = Infinity): number {
  // Every UTF-16 unit is at least one byte, so a long string is over without counting.
  if (text.length > limit) return text.length;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) { bytes += 4; i++; }
    else bytes += 3;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// C0 and C1 control characters, the line and paragraph separators.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// The same, but tab, line feed and carriage return are allowed (host text such as a game message).
const HOST_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;
// Bidirectional overrides and isolates, zero-width characters: allowed in no name.
const NAME_BAD_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
export const MAX_DEPTH = 6;
export const MAX_STRING = 2048;

/**
 * Structural check every frame passes before the relay looks at it: plain JSON only, at most
 * MAX_DEPTH levels, no prototype keys, finite numbers, no string over MAX_STRING characters and
 * no control characters in any string (a host may use tab and line breaks). Returns false for anything else.
 */
export function isSafeValue(value: unknown, fromHost = false, depth = 0): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_STRING && !(fromHost ? HOST_CONTROL_RE : CONTROL_RE).test(value);
  if (typeof value !== 'object' || depth >= MAX_DEPTH) return false;
  if (Array.isArray(value)) {
    for (const item of value) if (!isSafeValue(item, fromHost, depth + 1)) return false;
    return true;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || key.length > 64 || CONTROL_RE.test(key)) return false;
    if (!isSafeValue((value as Record<string, unknown>)[key], fromHost, depth + 1)) return false;
  }
  return true;
}

/** A display name: 1 to NAME_MAX characters after trimming, no control, bidi or zero-width characters. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= NAME_MAX && !NAME_BAD_RE.test(name) ? name : null;
}

/** A phone id: 1 to PID_MAX printable ASCII characters, no spaces. */
export function isPid(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]+$/.test(value) && value.length <= PID_MAX;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const shortText = (value: unknown, max = 32) => typeof value === 'string' && value.length <= max;

/** Field checks per phone message type, on top of isSafeValue. Unknown extra fields are allowed. */
export const PHONE_SHAPES: Readonly<Record<string, (m: WireMessage) => boolean>> = {
  swing: (m) => isSwing(m),
  trace: () => true,
  raw: (m) => Array.isArray(m.s) && m.s.length >= 1 && m.s.length <= 8 && m.s.every(isRawSample),
  status: (m) => (m.motion === 'ok' || m.motion === 'denied' || m.motion === 'none') && typeof m.wake === 'boolean'
    && (m.handedness === undefined || shortText(m.handedness)) && (m.colour === undefined || shortText(m.colour)),
  pong: (m) => finite(m.h) && finite(m.p),
  'player-info': (m) => shortText(m.hand) && shortText(m.colour),
  profile: () => true,
};

export type Message = WireMessage;
