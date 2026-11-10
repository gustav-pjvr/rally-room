/**
 * Pure logic between the phones and the match (DESIGN.md section 3, Phase 3
 * messages): who plays, the names and colours the match gets, and the
 * messages each playing phone is sent. No DOM, no sockets, so it is unit
 * tested (tests/host/phones.test.ts).
 */
import type { MatchConfig, MatchEvent, MatchView } from '../engine/types';

/** One phone the host knows about, by relay slot (1 to 4). */
export interface Phone {
  slot: number;
  name: string;
  /** Validated #rrggbb from player-info, or null for the default. */
  color: string | null;
  connected: boolean;
  /** Join order: lower joined first. Kept across reconnects of the same phone id. */
  seq: number;
  /** The phone's id (the relay's pid): the same person across reloads, new tabs and slots. */
  id?: string;
  /** Host time (performance.now) the phone dropped, while disconnected. */
  leftAt?: number;
}

/** Longest name the match shows (score bug, big messages). The relay allows 40. */
export const MAX_NAME = 16;
/** Player colours when a phone sent none (the match's own defaults). */
export const DEFAULT_COLORS = ['#e8743b', '#2a8c8c'];

/** Trim a name to MAX_NAME characters, ending with an ellipsis when cut. */
export function shortName(name: string): string {
  const chars = [...name.trim()];
  if (chars.length <= MAX_NAME) return chars.join('');
  return chars.slice(0, MAX_NAME - 1).join('').trimEnd() + '…';
}

/** Accept only a plain hex colour, since it ends up in styles. */
export function safeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return ('#' + [...v.slice(1)].map((c) => c + c).join('')).toLowerCase();
  return null;
}

/** Phones in join order. */
export function byJoinOrder(phones: Iterable<Phone>): Phone[] {
  return [...phones].sort((a, b) => a.seq - b.seq);
}

/** Humans to suggest for doubles: one per connected phone, at least 1, at most 2. */
export function suggestedHumans(phones: Iterable<Phone>): 1 | 2 {
  return [...phones].filter((p) => p.connected).length >= 2 ? 2 : 1;
}

export interface Assignment {
  humans: 1 | 2;
  /** slots[i] is the phone slot playing match player i, or null when the keyboard plays it. */
  slots: (number | null)[];
}

/**
 * Who plays the next match. Players 1 and 2 are the first two connected
 * phones to join; human players with no phone are played with the keyboard.
 */
export function assignPlayers(phones: Iterable<Phone>, mode: MatchConfig['mode'], humansWanted: 1 | 2): Assignment {
  const humans: 1 | 2 = mode === 'singles' ? 1 : humansWanted;
  const connected = byJoinOrder(phones).filter((p) => p.connected);
  const slots = Array.from({ length: humans }, (_, i) => connected[i]?.slot ?? null);
  return { humans, slots };
}

/** Index of the match player a slot plays, or -1. */
export function playerOfSlot(a: Assignment, slot: number): number {
  return a.slots.indexOf(slot);
}

/** Names and colours for MatchConfig: from the phones, undefined entries fall back to the match defaults. */
export function matchIdentity(a: Assignment, phones: Map<number, Phone>): Pick<MatchConfig, 'names' | 'colors'> {
  const names: string[] = [];
  const colors: string[] = [];
  a.slots.forEach((slot, i) => {
    const phone = slot === null ? undefined : phones.get(slot);
    names[i] = phone ? shortName(phone.name) || `Player ${i + 1}` : `Player ${i + 1}`;
    colors[i] = phone?.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length];
  });
  return { names, colors };
}

// ---- Phone records ----

/**
 * Records a phone that joined or rejoined on `slot`. The same id keeps its join
 * order and colour even on a new slot (its old card goes); a new id is a new
 * person at the back of the queue, even on a slot number someone used before.
 */
export function phoneJoined(phones: Map<number, Phone>, slot: number, name: string, id: string, nextSeq: () => number): Phone {
  const before = [...phones.values()].find((p) => p.id === id);
  if (before && before.slot !== slot) phones.delete(before.slot);
  const p: Phone = { slot, name, color: before?.color ?? null, connected: true, seq: before?.seq ?? nextSeq(), id };
  phones.set(slot, p);
  return p;
}

/** Slots whose phone has been gone longer than the relay's hold (minus the ones `keep` says to keep). */
export function expiredSlots(phones: Map<number, Phone>, now: number, keep: (p: Phone) => boolean, holdMs = 60_000): number[] {
  return [...phones.values()]
    .filter((p) => !p.connected && p.leftAt !== undefined && now - p.leftAt >= holdMs && !keep(p))
    .map((p) => p.slot);
}

// ---- Match players bound to phones (DESIGN.md section 3, identity) ----

/**
 * One human player of the match in progress. It belongs to a phone id, not a
 * slot: a phone that comes back on any slot plays it again, and a new phone
 * never takes it over.
 */
export interface Seat {
  /** Phone id playing this player, or null when the keyboard played it from the start. */
  id: string | null;
  /** Short name for "Waiting for <name>'s phone". */
  name: string;
  /** Slot the phone is on now, or null while it is away. */
  slot: number | null;
  /** False after a rejoin until the phone reports motion 'ok' (it cannot swing before). */
  ready: boolean;
  /** The host chose "Continue with the keyboard": not waited for. Cleared when the phone is back and ready. */
  keyboard: boolean;
}

export function createSeats(a: Assignment, phones: Map<number, Phone>): Seat[] {
  return a.slots.map((slot, i) => {
    const p = slot === null ? undefined : phones.get(slot);
    return p
      ? { id: p.id ?? null, name: shortName(p.name) || `Player ${i + 1}`, slot, ready: true, keyboard: false }
      : { id: null, name: `Player ${i + 1}`, slot: null, ready: true, keyboard: true };
  });
}

/** Slots per match player, for the hit, miss and game messages (null: no phone to tell). */
export function seatSlots(seats: Seat[]): (number | null)[] {
  return seats.map((s) => s.slot);
}

/**
 * A phone joined on `slot`. Returns the match player its id plays, or -1 (a
 * watcher). Any other player still bound to that slot number loses it.
 */
export function seatIn(seats: Seat[], id: string, slot: number): number {
  let player = -1;
  seats.forEach((s, i) => {
    if (s.id !== null && s.id === id) { s.slot = slot; s.ready = false; player = i; }
    else if (s.slot === slot) { s.slot = null; s.ready = false; }
  });
  return player;
}

/** The phone on `slot` dropped. Returns the match player it played, or -1. */
export function seatOut(seats: Seat[], slot: number): number {
  const i = seats.findIndex((s) => s.slot === slot);
  if (i >= 0) { seats[i].slot = null; seats[i].ready = false; }
  return i;
}

/** The phone on `slot` reported motion 'ok': it plays again (and takes over from the keyboard). */
export function seatReady(seats: Seat[], slot: number): number {
  const i = seats.findIndex((s) => s.slot === slot);
  if (i >= 0) { seats[i].ready = true; seats[i].keyboard = false; }
  return i;
}

/** Match players the game waits for: away, back but not ready, or silent (`live` false). */
export function missingPlayers(seats: Seat[], live: (slot: number) => boolean): number[] {
  return seats.flatMap((s, i) => (!s.keyboard && (s.slot === null || !s.ready || !live(s.slot)) ? [i] : []));
}

/** "Continue with the keyboard" for these players. Returns them. */
export function takeOverWithKeyboard(seats: Seat[], players: number[]): number[] {
  for (const i of players) if (seats[i]) seats[i].keyboard = true;
  return players;
}

export function waitingText(seats: Seat[], missing: number[]): string {
  const names = missing.map((i) => `${seats[i].name}'s`);
  return `Waiting for ${names.join(' and ')} phone${missing.length > 1 ? 's' : ''}`;
}

/** A playing phone with no pong for longer than this counts as missing (pings go every 2 s). */
export const PONG_TIMEOUT_MS = 6000;

// ---- Host > phone messages ----

export type GameState = 'wait' | 'serve' | 'toss' | 'rally' | 'paused' | 'over';

export type PhoneMessage =
  | { t: 'mode'; to: number; mode: 'lobby' | 'play' }
  | { t: 'you'; to: number; player: number | null; color: string; team: string | null }
  | { t: 'game'; to: number; state: GameState; score: string; message: string | null }
  | { t: 'hit'; to: number; quality: number; u: number; v: number; frame: boolean }
  | { t: 'miss'; to: number };

/** Face coordinates sent to the phone are clamped to the frame's outer edge (contact.ts CONTACT.frameEdge). */
const FACE_LIMIT = 1.25;

/** What a player's phone should prompt, from the match view. */
export function gameState(view: MatchView, player: number, paused: boolean): GameState {
  if (view.phase === 'match-over') return 'over';
  if (paused) return 'paused';
  if (view.phase === 'serve-wait' && view.serverIndex === player) return 'serve';
  if (view.phase === 'toss' && view.serverIndex === player) return 'toss';
  if (view.phase === 'rally') return 'rally';
  return 'wait';
}

/** Short score line for the phone, the humans' side first: "30-15, games 1-0". */
export function scoreText(view: MatchView): string {
  const s = view.score;
  const points = `${s.points[0]}-${s.points[1]}`;
  return `${s.tiebreak ? 'Tiebreak ' : ''}${points}, games ${s.games[0]}-${s.games[1]}`;
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);

/**
 * hit and miss messages for one frame's events. A hit carries where the ball
 * met the face: `u` = a (along the racket, -1 throat .. +1 tip), `v` = b
 * (across it, -1 bottom .. +1 top), `frame` for a frame hit.
 *
 * A phone gets at most one miss per ball, and only once the outcome is known.
 * A whiff does not end the chance (a later swing in the window may still touch
 * the ball, DESIGN.md section 3), so a whiff alone sends nothing: it is only
 * remembered in `whiffed` (kept by the caller across frames). The point decides:
 * 'missed' and 'ace' are the receiver's miss (`receiverBefore` is the player who
 * was receiving in the previous frame's view; an unreturned serve shakes the
 * receiving phone like any other missed ball), and 'winner' is a miss for every
 * remembered whiffer (an unreachable ball they swung at). A hit by the whiffer
 * forgets the whiff, and every point clears the memory.
 */
export function eventMessages(
  events: MatchEvent[], a: Assignment, receiverBefore: number | null, whiffed: Set<number> = new Set(),
): PhoneMessage[] {
  const out: PhoneMessage[] = [];
  const missed = new Set<number>();
  const slotOf = (player: number) => a.slots[player] ?? null;
  const miss = (player: number | null) => {
    if (player === null || missed.has(player)) return;
    const to = slotOf(player);
    if (to === null) return;
    missed.add(player);
    out.push({ t: 'miss', to });
  };
  for (const e of events) {
    if (e.type === 'hit') {
      whiffed.delete(e.player);
      const to = slotOf(e.player);
      if (to !== null) {
        out.push({
          t: 'hit', to, quality: clamp(e.quality, 0, 1),
          u: clamp(e.contact.a, -FACE_LIMIT, FACE_LIMIT), v: clamp(e.contact.b, -FACE_LIMIT, FACE_LIMIT), frame: e.contact.frame === true,
        });
      }
    } else if (e.type === 'whiff') {
      whiffed.add(e.player);
    } else if (e.type === 'point') {
      if (e.reason === 'missed' || e.reason === 'ace') miss(receiverBefore);
      else if (e.reason === 'winner') for (const player of whiffed) miss(player);
      whiffed.clear();
    }
  }
  return out;
}

/** The game message each playing phone should currently show (send through a ChangeFilter). */
export function gameMessages(view: MatchView, a: Assignment, paused: boolean): PhoneMessage[] {
  const out: PhoneMessage[] = [];
  const score = scoreText(view);
  a.slots.forEach((to, player) => {
    if (to === null) return;
    out.push({ t: 'game', to, state: gameState(view, player, paused), score, message: view.message });
  });
  return out;
}

/** Team name for the score line: the human players' names. */
export function teamName(names: string[]): string {
  return names.join(' & ');
}

/** The you message for every connected phone. Phones not in the next match get player null. */
export function youMessages(phones: Iterable<Phone>, a: Assignment, names: string[], colors: string[]): PhoneMessage[] {
  const out: PhoneMessage[] = [];
  const team = teamName(names);
  for (const p of byJoinOrder(phones)) {
    if (!p.connected) continue;
    const i = playerOfSlot(a, p.slot);
    out.push(i < 0
      ? { t: 'you', to: p.slot, player: null, color: p.color ?? DEFAULT_COLORS[0], team: null }
      : { t: 'you', to: p.slot, player: i + 1, color: colors[i], team });
  }
  return out;
}

/**
 * Passes a 'game' or 'you' message only when it differs from the last one
 * sent to that slot. forget(slot) makes the next one go through (a rejoin).
 */
export class ChangeFilter {
  private last = new Map<string, string>();

  pass(m: PhoneMessage): boolean {
    const key = `${m.to}:${m.t}`;
    const json = JSON.stringify(m);
    if (this.last.get(key) === json) return false;
    this.last.set(key, json);
    return true;
  }

  forget(slot?: number): void {
    if (slot === undefined) { this.last.clear(); return; }
    for (const key of [...this.last.keys()]) if (key.startsWith(`${slot}:`)) this.last.delete(key);
  }
}
