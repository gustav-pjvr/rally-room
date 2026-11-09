export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const SLOT_COUNT = 4;
export const SLOT_HOLD_MS = 60_000;
/** The relay pings every socket this often and closes one that did not answer the last ping. */
export const RELAY_HEARTBEAT_MS = 10_000;
/** The only message types a phone may send; the relay drops anything else from a phone. */
export const PHONE_TYPES: readonly string[] = ['swing', 'raw', 'status', 'pong', 'player-info', 'profile'];

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
export interface WireMessage {
  t: string;
  [key: string]: unknown;
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

export type Message = WireMessage;
