// The Durable Object adapter: one object per room code, so rooms are isolated by construction. It
// runs the same relay core as the Node adapter, holding exactly one room. Sockets are accepted
// through the hibernation API; the core's state is stored after every change, so a room survives
// the object being evicted while its sockets stay open. Rate buckets and strikes live in memory
// only and start full after a wake (an object only hibernates after a quiet spell).
import { HEARTBEAT_FRAME, isRoomCode } from '../src/shared/protocol';
import { RelayCore, type Action, type CoreSnapshot, type Endpoint } from '../server/core';
import { intVar, upgradeResponse, workers, type DurableState, type Env, type HibernatableSocket } from './types';

/** Sockets one room object serves at most: a host, four phones and some slack for reconnects. */
export const MAX_ROOM_SOCKETS = 16;

interface Saved { code: string; snapshot: CoreSnapshot }
interface Attachment { peer: string }

export class RelayRoom {
  private core: RelayCore | undefined;
  private code: string | undefined;
  private sockets = new Map<string, HibernatableSocket>();
  private saved = -1;
  private alarmAt: number | null = null;

  constructor(private readonly ctx: DurableState, private readonly env: Env) {
    // `{"t":"hb"}` is answered by the runtime without waking the object; its time is read in alarm().
    ctx.setWebSocketAutoResponse(new workers.WebSocketRequestResponsePair(HEARTBEAT_FRAME, HEARTBEAT_FRAME));
    void ctx.blockConcurrencyWhile(() => this.load());
  }

  /** Called by the Worker with the room code and intent it chose; the client cannot set these headers. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const code = request.headers.get('x-relay-code') ?? '';
    const intent = request.headers.get('x-relay-intent');
    if (!isRoomCode(code) || (intent !== 'create' && intent !== 'room')) return new Response('Bad relay request', { status: 400 });
    if (this.code !== undefined && this.code !== code) return new Response('Wrong room object', { status: 400 });
    const core = this.ensureCore(code);
    if (intent === 'create' && !core.canCreate()) return new Response('Room code in use', { status: 409 });
    if (intent === 'room' && !core.hasRoom(code)) return new Response('No such room', { status: 404 });
    const pair = new workers.WebSocketPair();
    const endpoint: Endpoint = intent === 'create' ? { kind: 'create' } : { kind: 'room', code };
    await this.connect(pair[1], code, endpoint, request.headers.get('x-relay-addr') ?? '');
    return upgradeResponse(pair[0]);
  }

  /** Accept a server socket for a new peer (split from fetch so the local harness can drive it). */
  async connect(socket: HibernatableSocket, code: string, endpoint: Endpoint, addr: string) {
    const core = this.ensureCore(code);
    const peer = crypto.randomUUID();
    this.ctx.acceptWebSocket(socket);
    socket.serializeAttachment({ peer } satisfies Attachment);
    this.sockets.set(peer, socket);
    await this.run(core.open(peer, endpoint, Date.now(), addr));
  }

  async webSocketMessage(socket: HibernatableSocket, message: string | ArrayBuffer) {
    const peer = this.peerOf(socket);
    if (!peer || !this.core) return;
    await this.run(this.core.receive(peer, typeof message === 'string' ? message : null, Date.now()));
  }

  async webSocketClose(socket: HibernatableSocket) {
    const peer = this.peerOf(socket);
    try { socket.close(1000, 'closed'); } catch { /* already closed */ }
    if (!peer || !this.core) return;
    this.sockets.delete(peer);
    await this.run(this.core.close(peer, Date.now()));
  }

  async webSocketError(socket: HibernatableSocket) {
    await this.webSocketClose(socket);
  }

  async alarm() {
    this.alarmAt = null;
    if (!this.core) return;
    for (const [peer, socket] of this.sockets) {
      const answered = this.ctx.getWebSocketAutoResponseTimestamp(socket);
      if (answered) this.core.seen(peer, answered.getTime());
    }
    await this.run(this.core.tick(Date.now()), true);
  }

  private async load() {
    const saved = await this.ctx.storage.get<Saved>('relay');
    this.alarmAt = await this.ctx.storage.getAlarm();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (attachment?.peer) this.sockets.set(attachment.peer, socket);
    }
    if (!saved) return;
    const now = Date.now();
    const core = this.ensureCore(saved.code);
    core.restore(saved.snapshot, now);
    this.saved = core.revision;
    // A peer the core remembers whose socket is gone closed while the object was away.
    const actions: Action[] = [];
    for (const peer of core.peerIds()) if (!this.sockets.has(peer)) actions.push(...core.close(peer, now));
    // A socket the core does not know (its state was never stored) cannot be served.
    const known = new Set(core.peerIds());
    for (const [peer, socket] of this.sockets) {
      if (!known.has(peer)) { this.sockets.delete(peer); try { socket.close(1011, 'lost'); } catch { /* gone */ } }
    }
    await this.run(actions, true);
  }

  private ensureCore(code: string): RelayCore {
    if (this.core) return this.core;
    this.code = code;
    this.core = new RelayCore({
      fixedCode: code,
      maxRooms: 1,
      maxPeers: MAX_ROOM_SOCKETS,
      randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
      hostHoldMs: intVar(this.env.RELAY_HOST_HOLD_MS),
      handshakeMs: intVar(this.env.RELAY_HANDSHAKE_MS),
      idleMs: intVar(this.env.RELAY_IDLE_MS),
      slotHoldMs: intVar(this.env.RELAY_SLOT_HOLD_MS),
      addressFailures: intVar(this.env.RELAY_ADDRESS_LIMIT) !== undefined
        ? { limit: intVar(this.env.RELAY_ADDRESS_LIMIT)!, decayPerS: 0.5 } : undefined,
    });
    return this.core;
  }

  private peerOf(socket: HibernatableSocket): string | undefined {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    const peer = attachment?.peer;
    if (peer && !this.sockets.has(peer)) this.sockets.set(peer, socket);
    return peer;
  }

  /** Carry out the core's actions, store the state if it changed, and keep the alarm on the next deadline. */
  private async run(actions: Action[], rearm = false) {
    for (const action of actions) {
      const socket = this.sockets.get(action.peer);
      if (!socket) continue;
      try {
        if (action.kind === 'send') socket.send(JSON.stringify(action.message));
        else { this.sockets.delete(action.peer); socket.close(action.code, action.reason); }
      } catch { /* the socket closed under us; its close event cleans up */ }
    }
    const core = this.core;
    const code = this.code;
    if (!core || code === undefined) return;
    const changed = core.revision !== this.saved;
    if (changed) {
      this.saved = core.revision;
      if (core.roomCount === 0 && core.peerCount === 0) {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.alarmAt = null;
        return;
      }
      await this.ctx.storage.put('relay', { code, snapshot: core.snapshot() } satisfies Saved);
    }
    if (!changed && !rearm && this.alarmAt !== null) return;
    const next = core.nextDeadline();
    if (next === undefined) {
      if (this.alarmAt !== null) await this.ctx.storage.deleteAlarm();
      this.alarmAt = null;
    } else if (rearm || this.alarmAt === null || next < this.alarmAt) {
      this.alarmAt = next;
      await this.ctx.storage.setAlarm(next);
    }
  }
}

/** The Worker uses this to tell a missing room from an occupied one before it answers the client. */
export const roomStatus = { taken: 409, missing: 404 } as const;
