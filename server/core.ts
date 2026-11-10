// The relay's room rules, pure: no sockets, no timers, no Node or Cloudflare imports. Time comes in
// as `now` on every call and randomness through `randomBytes`, so the Node adapter (server/relay.ts),
// the Durable Object adapter (worker/room.ts) and the unit tests drive the same code.
//
// The adapters turn socket events into calls (`open`, `receive`, `seen`, `close`, `tick`) and carry
// out the returned actions in order: send a message to a peer, or close a peer's socket. When the core
// asks for a close it has already removed the peer, so the adapter's later `close` call is a no-op.
import {
  ADDRESS_FAILURES, CLOSE_CODES, CONTROL_MESSAGE_BYTES, HANDSHAKE_MS, HOST_HOLD_MS, HOST_MESSAGE_BYTES,
  IDLE_MS, MAX_FAILED_JOINS, MAX_FRAME_BYTES, MAX_ROOMS, MAX_ROOMS_PER_ADDRESS, PHONE_MESSAGE_BYTES, PHONE_SHAPES, PHONE_TYPES,
  RATE_LIMITS, RELAY_TYPES, ROOM_ALPHABET, SLOT_COUNT, SLOT_HOLD_MS, STRIKES,
  cleanName, isPid, isRoomCode, isSafeValue, parseMessage, utf8Length,
  type ErrorReason, type RateLimit, type WireMessage,
} from '../src/shared/protocol';

/** Which URL a socket opened: the v1 `/ws`, `/ws/host` (new room) or `/ws/room/<code>`. */
export type Endpoint = { kind: 'legacy' } | { kind: 'create' } | { kind: 'room'; code: string };

/** Map a request path to an endpoint under `base` (normally `/ws`), or null when it is not the relay's. */
export function endpointFor(url: string | undefined, base = '/ws'): Endpoint | null {
  const path = (url ?? '').split('?')[0];
  if (path === base) return { kind: 'legacy' };
  if (path === `${base}/host`) return { kind: 'create' };
  if (path.startsWith(`${base}/room/`)) {
    let code = path.slice(base.length + 6);
    try { code = decodeURIComponent(code); } catch { code = ''; }
    return { kind: 'room', code: code.toUpperCase() };
  }
  return null;
}

export type Action =
  | { kind: 'send'; peer: string; message: WireMessage }
  | { kind: 'close'; peer: string; code: number; reason: string };

export interface CoreOptions {
  /** A cryptographically secure source (Node `crypto.randomFillSync`, Workers `crypto.getRandomValues`). */
  randomBytes(length: number): Uint8Array;
  /** A Durable Object holds one room under its own code; leave unset to pick random codes. */
  fixedCode?: string;
  maxRooms?: number;
  /** Rooms whose host socket comes from one address, at most. */
  maxRoomsPerAddress?: number;
  /** Sockets this instance serves at most; more are refused with `busy`. */
  maxPeers?: number;
  hostHoldMs?: number;
  handshakeMs?: number;
  idleMs?: number;
  slotHoldMs?: number;
  maxFailedJoins?: number;
  addressFailures?: { limit: number; decayPerS: number };
}

interface Player { pid: string; name: string; peer?: string; leftAt?: number }
interface Room {
  code: string;
  key: string;
  /** The host socket; unset while the host is away (held rooms only). */
  host?: string;
  hostLeftAt?: number;
  /** Rooms made through `/ws/host` are held when the host drops; v1 rooms close at once. */
  holds: boolean;
  /** Reserved by a `/ws/host` socket that has not sent `{t:'host'}` yet. */
  pending: boolean;
  players: Map<number, Player>;
}
interface Peer {
  id: string;
  endpoint: Endpoint;
  addr: string;
  room?: string;
  slot?: number;
  host: boolean;
  /** Set while the socket is neither host nor player: the handshake clock runs from here. */
  since?: number;
  lastSeen: number;
  failed: number;
  messages: Bucket;
  bytes: Bucket;
  strikes: number;
  strikeAt: number;
}

/** What a Durable Object stores so a room survives hibernation (buckets and strikes start fresh). */
export interface CoreSnapshot {
  rooms: { code: string; key: string; host?: string; hostLeftAt?: number; holds: boolean; pending: boolean;
    players: [number, Player][] }[];
  peers: { id: string; endpoint: Endpoint; addr: string; room?: string; slot?: number; host: boolean;
    since?: number; failed: number }[];
}

export class Bucket {
  private tokens: number;
  constructor(private readonly limit: RateLimit, private at: number) { this.tokens = limit.burst; }
  take(amount: number, now: number): boolean {
    const elapsed = Math.max(0, now - this.at) / 1000;
    this.at = Math.max(this.at, now);
    this.tokens = Math.min(this.limit.burst, this.tokens + elapsed * this.limit.rate);
    if (this.tokens < amount) return false;
    this.tokens -= amount;
    return true;
  }
}

/** Failed attempts per client address, decaying over time, with a bounded table. */
export class AddressLimiter {
  private scores = new Map<string, { score: number; at: number }>();
  constructor(private readonly limit: number = ADDRESS_FAILURES.limit, private readonly decayPerS: number = ADDRESS_FAILURES.decayPerS,
    private readonly maxEntries = 4096) {}
  private current(addr: string, now: number): number {
    const entry = this.scores.get(addr);
    if (!entry) return 0;
    return Math.max(0, entry.score - Math.max(0, now - entry.at) / 1000 * this.decayPerS);
  }
  /** Part-forgiven failures count as whole ones: blocked from `limit` until a whole failure has decayed. */
  blocked(addr: string, now: number): boolean { return Math.ceil(this.current(addr, now) - 1e-9) >= this.limit; }
  fail(addr: string, now: number) {
    const score = this.current(addr, now) + 1;
    this.scores.delete(addr);
    this.scores.set(addr, { score, at: now });
    if (this.scores.size > this.maxEntries) {
      for (const [key] of this.scores) {
        if (this.current(key, now) < 1 || this.scores.size > this.maxEntries) this.scores.delete(key);
        if (this.scores.size <= this.maxEntries / 2) break;
      }
    }
  }
}

/** Compares a secret with a guess in time that depends only on the secret's length. */
export function safeEqual(secret: string, guess: string): boolean {
  let diff = secret.length ^ guess.length;
  const n = guess.length || 1;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ (guess.charCodeAt(i % n) || 0);
  return diff === 0;
}

const HEX = '0123456789abcdef';
const CAPACITY = ROOM_ALPHABET.length ** 4;

export class RelayCore {
  private rooms = new Map<string, Room>();
  private peers = new Map<string, Peer>();
  private addresses: AddressLimiter;
  private readonly o: Required<Omit<CoreOptions, 'fixedCode'>> & { fixedCode?: string };
  /** Bumped on every change a Durable Object must persist (not on forwards or rate drops). */
  revision = 0;

  constructor(options: CoreOptions) {
    // An option given as undefined keeps its default (adapters pass unset settings through).
    const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as CoreOptions;
    this.o = {
      maxRooms: MAX_ROOMS, maxRoomsPerAddress: MAX_ROOMS_PER_ADDRESS, maxPeers: 1024, hostHoldMs: HOST_HOLD_MS, handshakeMs: HANDSHAKE_MS, idleMs: IDLE_MS,
      slotHoldMs: SLOT_HOLD_MS, maxFailedJoins: MAX_FAILED_JOINS, addressFailures: ADDRESS_FAILURES, ...given,
    };
    this.addresses = new AddressLimiter(this.o.addressFailures.limit, this.o.addressFailures.decayPerS);
  }

  get roomCount(): number { return this.rooms.size; }
  get peerCount(): number { return this.peers.size; }
  /** A phone or a resuming host may open `/ws/room/<code>` only while the room is live. */
  hasRoom(code: string): boolean { const room = this.rooms.get(code); return !!room && !room.pending; }
  canCreate(): boolean { return this.rooms.size < this.o.maxRooms && this.pickCode() !== undefined; }

  /** A socket opened. `addr` is the client address, for the per-address limit on failed attempts. */
  open(peer: string, endpoint: Endpoint, now: number, addr = ''): Action[] {
    if (this.peers.has(peer)) return [];
    if (this.addresses.blocked(addr, now)) return this.refuse(peer, 'too-many-attempts');
    if (this.peers.size >= this.o.maxPeers) return this.refuse(peer, 'busy');
    if (endpoint.kind === 'room' && !this.hasRoom(endpoint.code)) {
      this.addresses.fail(addr, now);
      return this.refuse(peer, 'no-room');
    }
    const p: Peer = {
      id: peer, endpoint, addr, host: false, since: now, lastSeen: now, failed: 0, strikes: 0, strikeAt: now,
      messages: new Bucket(RATE_LIMITS.phoneMessages, now), bytes: new Bucket(RATE_LIMITS.phoneBytes, now),
    };
    if (endpoint.kind === 'create') {
      const code = this.roomAllowed(addr) ? this.pickCode() : undefined;
      if (!code) return this.refuse(peer, 'busy');
      this.rooms.set(code, { code, key: '', host: peer, holds: true, pending: true, players: new Map() });
      p.room = code;
    }
    this.peers.set(peer, p);
    this.revision++;
    return [];
  }

  /** A frame arrived. `frame` is the text, or null for a binary frame. */
  receive(peer: string, frame: string | null, now: number): Action[] {
    const p = this.peers.get(peer);
    if (!p) return [];
    p.lastSeen = Math.max(p.lastSeen, now);
    if (frame === null) return [...this.error(p, 'invalid-message'), ...this.strike(p, now)];
    const bytes = utf8Length(frame, MAX_FRAME_BYTES);
    if (bytes > MAX_FRAME_BYTES) return this.drop(p, now, CLOSE_CODES.tooBig, 'too-big');
    if (!p.messages.take(1, now) || !p.bytes.take(bytes, now)) return this.strike(p, now);
    const m = parseMessage(frame);
    if (!m || !isSafeValue(m, p.host)) return [...this.error(p, 'invalid-message'), ...this.strike(p, now)];
    if (m.t === 'hb' || m.t === 'host' || m.t === 'join') {
      if (bytes > CONTROL_MESSAGE_BYTES) return [...this.error(p, 'too-big'), ...this.strike(p, now)];
      if (m.t === 'hb') return [{ kind: 'send', peer, message: { t: 'hb' } }];
      return m.t === 'host' ? this.host(p, m, now) : this.join(p, m, now);
    }
    return this.forward(p, m, bytes, now);
  }

  /** The socket proved it is alive (a protocol pong, or an auto-answered `hb`). */
  seen(peer: string, now: number) {
    const p = this.peers.get(peer);
    if (p) p.lastSeen = Math.max(p.lastSeen, now);
  }

  /** The socket closed. */
  close(peer: string, now: number): Action[] {
    const p = this.peers.get(peer);
    if (!p) return [];
    this.peers.delete(peer);
    this.revision++;
    return this.leave(p, now);
  }

  /** Expire held rooms, sockets that never finished a handshake and sockets that went silent. */
  tick(now: number): Action[] {
    const actions: Action[] = [];
    for (const room of [...this.rooms.values()]) {
      if (!room.host && room.hostLeftAt !== undefined && now - room.hostLeftAt >= this.o.hostHoldMs) {
        actions.push(...this.closeRoom(room));
      }
    }
    for (const p of [...this.peers.values()]) {
      if (!this.peers.has(p.id)) continue;
      if (p.since !== undefined && now - p.since >= this.o.handshakeMs) {
        actions.push(...this.drop(p, now, CLOSE_CODES.idle, 'handshake'));
      } else if (now - p.lastSeen >= this.o.idleMs) {
        actions.push(...this.drop(p, now, CLOSE_CODES.idle, 'idle'));
      }
    }
    return actions;
  }

  /** The earliest time `tick` has work to do, or undefined when nothing is waiting. */
  nextDeadline(): number | undefined {
    let next = Infinity;
    for (const room of this.rooms.values()) {
      if (!room.host && room.hostLeftAt !== undefined) next = Math.min(next, room.hostLeftAt + this.o.hostHoldMs);
    }
    for (const p of this.peers.values()) {
      next = Math.min(next, p.lastSeen + this.o.idleMs);
      if (p.since !== undefined) next = Math.min(next, p.since + this.o.handshakeMs);
    }
    return Number.isFinite(next) ? next : undefined;
  }

  snapshot(): CoreSnapshot {
    return {
      rooms: [...this.rooms.values()].map((room) => ({
        code: room.code, key: room.key, host: room.host, hostLeftAt: room.hostLeftAt, holds: room.holds,
        pending: room.pending, players: [...room.players].map(([slot, player]) => [slot, { ...player }]),
      })),
      peers: [...this.peers.values()].map((p) => ({
        id: p.id, endpoint: p.endpoint, addr: p.addr, room: p.room, slot: p.slot, host: p.host, since: p.since, failed: p.failed,
      })),
    };
  }

  /** Rebuild from a snapshot after hibernation; every peer counts as seen now. */
  restore(snapshot: CoreSnapshot, now: number) {
    this.rooms.clear();
    this.peers.clear();
    for (const room of snapshot.rooms) {
      this.rooms.set(room.code, { ...room, players: new Map(room.players.map(([slot, player]) => [slot, { ...player }])) });
    }
    for (const saved of snapshot.peers) {
      const bucketsFor = saved.host ? RATE_LIMITS.hostMessages : RATE_LIMITS.phoneMessages;
      this.peers.set(saved.id, {
        ...saved, lastSeen: now, strikes: 0, strikeAt: now,
        messages: new Bucket(bucketsFor, now), bytes: new Bucket(saved.host ? RATE_LIMITS.hostBytes : RATE_LIMITS.phoneBytes, now),
      });
    }
  }

  /** Peer ids the core knows; a Durable Object closes the ones whose socket is gone after waking. */
  peerIds(): string[] { return [...this.peers.keys()]; }

  // Handshakes

  private host(p: Peer, m: WireMessage, now: number): Action[] {
    const pendingRoom = p.room !== undefined ? this.rooms.get(p.room) : undefined;
    if (pendingRoom?.pending && pendingRoom.host === p.id && m.resume === undefined) {
      pendingRoom.pending = false;
      pendingRoom.key = this.newKey();
      this.becomeHost(p, pendingRoom);
      return [{ kind: 'send', peer: p.id, message: { t: 'room', code: pendingRoom.code, key: pendingRoom.key } }];
    }
    if (p.room !== undefined) return this.error(p, 'already-connected');
    if (m.resume !== undefined) return this.resume(p, m.resume, now);
    if (p.endpoint.kind !== 'legacy') return this.fail(p, 'wrong-endpoint', now);
    const code = this.roomAllowed(p.addr) ? this.pickCode() : undefined;
    if (!code) return this.error(p, 'busy');
    const room: Room = { code, key: this.newKey(), holds: false, pending: false, players: new Map() };
    this.rooms.set(code, room);
    this.becomeHost(p, room);
    return [{ kind: 'send', peer: p.id, message: { t: 'room', code, key: room.key } }];
  }

  private resume(p: Peer, resume: unknown, now: number): Action[] {
    if (!resume || typeof resume !== 'object' || Array.isArray(resume)) return this.fail(p, 'invalid-message', now);
    const { code, key } = resume as Record<string, unknown>;
    if (typeof code !== 'string' || typeof key !== 'string') return this.fail(p, 'invalid-message', now);
    if (p.endpoint.kind === 'create') return this.fail(p, 'wrong-endpoint', now);
    const upper = code.toUpperCase();
    if (p.endpoint.kind === 'room' && upper !== p.endpoint.code) return this.fail(p, 'no-room', now);
    const room = this.rooms.get(upper);
    if (!room || room.pending) return this.fail(p, 'no-room', now);
    if (!safeEqual(room.key, key)) return this.fail(p, 'bad-key', now);
    const actions: Action[] = [];
    const old = room.host !== undefined ? this.peers.get(room.host) : undefined;
    if (old) {
      // The old host socket is still open (a reload before its close arrived): the key wins.
      this.peers.delete(old.id);
      actions.push(...this.error(old, 'replaced'), { kind: 'close', peer: old.id, code: CLOSE_CODES.replaced, reason: 'replaced' });
    }
    const wasAway = room.host === undefined;
    room.hostLeftAt = undefined;
    room.key = this.newKey();
    this.becomeHost(p, room);
    actions.push({ kind: 'send', peer: p.id, message: { t: 'room', code: room.code, key: room.key, resumed: true } });
    for (const slot of [...room.players.keys()].sort((a, b) => a - b)) {
      const player = room.players.get(slot)!;
      actions.push({ kind: 'send', peer: p.id, message: {
        t: 'player', slot, name: player.name, state: player.peer ? 'in' : 'out', id: player.pid,
      } });
    }
    if (wasAway) for (const player of room.players.values()) {
      if (player.peer) actions.push({ kind: 'send', peer: player.peer, message: { t: 'host-back' } });
    }
    return actions;
  }

  private becomeHost(p: Peer, room: Room) {
    room.host = p.id;
    p.room = room.code;
    p.host = true;
    p.since = undefined;
    p.messages = new Bucket(RATE_LIMITS.hostMessages, p.lastSeen);
    p.bytes = new Bucket(RATE_LIMITS.hostBytes, p.lastSeen);
    this.revision++;
  }

  private join(p: Peer, m: WireMessage, now: number): Action[] {
    if (p.host) return this.error(p, 'already-connected');
    if (p.endpoint.kind === 'create') return this.fail(p, 'wrong-endpoint', now);
    if (p.room !== undefined) return this.error(p, 'already-connected');
    const name = cleanName(m.name);
    if (typeof m.room !== 'string' || !name || !isPid(m.pid)) return this.fail(p, 'invalid-join', now);
    const code = m.room.toUpperCase();
    if (p.endpoint.kind === 'room' && code !== p.endpoint.code) return this.fail(p, 'no-room', now);
    const room = isRoomCode(code) ? this.rooms.get(code) : undefined;
    if (!room || room.pending) return this.fail(p, 'no-room', now);
    const pid = m.pid;
    // A pid already in the room gets its own slot back, even after the hold expired, as long as
    // nobody else took it (then its record would have been replaced). A held slot is not free;
    // an expired one is, and its record is replaced when someone else takes it.
    const existing = [...room.players].find(([, player]) => player.pid === pid);
    const free = (candidate: number) => {
      const player = room.players.get(candidate);
      return !player || (!player.peer && now - (player.leftAt ?? now) >= this.o.slotHoldMs);
    };
    const slot = existing?.[0] ?? Array.from({ length: SLOT_COUNT }, (_, i) => i + 1).find(free);
    if (!slot) return this.fail(p, 'full', now);
    const actions: Action[] = [];
    const oldPeer = existing?.[1].peer !== undefined ? this.peers.get(existing[1].peer) : undefined;
    if (oldPeer) {
      oldPeer.room = undefined;
      oldPeer.slot = undefined;
      oldPeer.since = now;
      actions.push(...this.error(oldPeer, 'rejoined'));
    }
    room.players.set(slot, { pid, name, peer: p.id });
    p.room = code;
    p.slot = slot;
    p.since = undefined;
    this.revision++;
    actions.push({ kind: 'send', peer: p.id, message: { t: 'joined', slot } });
    if (room.host) actions.push({ kind: 'send', peer: room.host, message: { t: 'player', slot, name, state: 'in', id: pid } });
    return actions;
  }

  // Traffic

  private forward(p: Peer, m: WireMessage, bytes: number, now: number): Action[] {
    if (p.room === undefined) return [];
    const room = this.rooms.get(p.room);
    if (!room || room.pending) return [];
    if (!p.host) {
      // A phone may only send phone messages: never 'player', 'room' or anything the host trusts from the relay.
      if (p.slot === undefined || !PHONE_TYPES.includes(m.t)) return [];
      if (bytes > (PHONE_MESSAGE_BYTES[m.t] ?? 0)) return [...this.error(p, 'too-big'), ...this.strike(p, now)];
      if (!PHONE_SHAPES[m.t]?.(m)) return [...this.error(p, 'invalid-message'), ...this.strike(p, now)];
      if (!room.host) return [];
      // The relay owns slot, to and id: whatever the phone wrote there is dropped, and slot is its real slot.
      const { slot: _slot, to: _to, id: _id, ...rest } = m;
      return [{ kind: 'send', peer: room.host, message: { ...rest, t: m.t, slot: p.slot } }];
    }
    if (RELAY_TYPES.includes(m.t)) return [];
    if (bytes > HOST_MESSAGE_BYTES) return [...this.error(p, 'too-big'), ...this.strike(p, now)];
    if (typeof m.to !== 'number' || !Number.isInteger(m.to)) return [];
    const target = room.players.get(m.to)?.peer;
    return target ? [{ kind: 'send', peer: target, message: { ...m } }] : [];
  }

  // Leaving

  private leave(p: Peer, now: number): Action[] {
    if (p.room === undefined) return [];
    const room = this.rooms.get(p.room);
    if (!room) return [];
    if (room.host === p.id) {
      if (room.pending) { this.rooms.delete(room.code); return []; }
      if (!room.holds) return this.closeRoom(room);
      room.host = undefined;
      room.hostLeftAt = now;
      const actions: Action[] = [];
      for (const player of room.players.values()) {
        if (player.peer) actions.push({ kind: 'send', peer: player.peer, message: { t: 'host-away' } });
      }
      return actions;
    }
    if (p.slot === undefined) return [];
    const player = room.players.get(p.slot);
    if (!player || player.peer !== p.id) return [];
    player.peer = undefined;
    player.leftAt = now;
    if (!room.host) return [];
    return [{ kind: 'send', peer: room.host, message: { t: 'player', slot: p.slot, name: player.name, state: 'out', id: player.pid } }];
  }

  private closeRoom(room: Room): Action[] {
    this.rooms.delete(room.code);
    this.revision++;
    const actions: Action[] = [];
    for (const player of room.players.values()) {
      if (!player.peer) continue;
      this.peers.delete(player.peer);
      actions.push(
        { kind: 'send', peer: player.peer, message: { t: 'host-gone' } },
        { kind: 'close', peer: player.peer, code: CLOSE_CODES.roomClosed, reason: 'host-gone' },
      );
    }
    if (room.host !== undefined && this.peers.has(room.host)) this.peers.delete(room.host);
    return actions;
  }

  // Penalties

  /** A failed join or resume: counts per socket and per address; the last allowed one closes the socket. */
  private fail(p: Peer, reason: ErrorReason, now: number): Action[] {
    p.failed++;
    this.revision++;
    this.addresses.fail(p.addr, now);
    const actions = this.error(p, reason);
    if (p.failed >= this.o.maxFailedJoins) {
      actions.push(...this.error(p, 'too-many-attempts'), ...this.drop(p, now, CLOSE_CODES.policy, 'too-many-attempts'));
    }
    return actions;
  }

  private strike(p: Peer, now: number): Action[] {
    p.strikes = Math.max(0, p.strikes - Math.max(0, now - p.strikeAt) / 1000 * STRIKES.decayPerS) + 1;
    p.strikeAt = now;
    return p.strikes > STRIKES.close ? this.drop(p, now, CLOSE_CODES.policy, 'abuse') : [];
  }

  /** Remove a peer as if its socket closed, then ask the adapter to close the socket. */
  private drop(p: Peer, now: number, code: number, reason: string): Action[] {
    if (!this.peers.has(p.id)) return [];
    this.peers.delete(p.id);
    this.revision++;
    return [...this.leave(p, now), { kind: 'close', peer: p.id, code, reason }];
  }

  private refuse(peer: string, reason: ErrorReason): Action[] {
    return [
      { kind: 'send', peer, message: { t: 'error', reason } },
      { kind: 'close', peer, code: CLOSE_CODES.policy, reason },
    ];
  }

  private error(p: Peer, reason: ErrorReason): Action[] {
    return [{ kind: 'send', peer: p.id, message: { t: 'error', reason } }];
  }

  // Codes and keys

  private roomAllowed(addr: string): boolean {
    if (this.rooms.size >= this.o.maxRooms) return false;
    let hosted = 0;
    for (const room of this.rooms.values()) {
      if (room.host !== undefined && this.peers.get(room.host)?.addr === addr) hosted++;
    }
    return hosted < this.o.maxRoomsPerAddress;
  }

  private pickCode(): string | undefined {
    if (this.o.fixedCode !== undefined) return this.rooms.has(this.o.fixedCode) ? undefined : this.o.fixedCode;
    const bytes = this.o.randomBytes(4);
    const start = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    for (let attempt = 0; attempt < CAPACITY; attempt++) {
      let value = (start + attempt) % CAPACITY;
      let code = '';
      for (let i = 0; i < 4; i++) {
        code = ROOM_ALPHABET[value % ROOM_ALPHABET.length] + code;
        value = Math.floor(value / ROOM_ALPHABET.length);
      }
      if (!this.rooms.has(code)) return code;
    }
    return undefined;
  }

  /** 128 random bits as 32 hex characters. */
  private newKey(): string {
    let key = '';
    for (const byte of this.o.randomBytes(16)) key += HEX[byte >> 4] + HEX[byte & 15];
    return key;
  }
}
