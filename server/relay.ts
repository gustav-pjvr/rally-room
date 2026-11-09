import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import {
  parseMessage, PHONE_TYPES, RELAY_HEARTBEAT_MS, ROOM_ALPHABET, SLOT_COUNT, SLOT_HOLD_MS, type WireMessage,
} from '../src/shared/protocol';

interface Player { pid: string; name: string; peer?: string; leftAt?: number }
interface Room { host: string; players: Map<number, Player> }
interface Membership { room: string; slot?: number }
export interface Delivery { peer: string; message: WireMessage }

export class Rooms {
  private rooms = new Map<string, Room>();
  private members = new Map<string, Membership>();

  constructor(private random: () => number = Math.random) {}

  createRoom(host: string): Delivery[] {
    if (this.members.has(host)) return this.error(host, 'already-connected');
    const capacity = ROOM_ALPHABET.length ** 4;
    const start = Math.floor(this.random() * capacity) % capacity;
    for (let attempt = 0; attempt < capacity; attempt++) {
      let value = (start + attempt) % capacity;
      let code = '';
      for (let i = 0; i < 4; i++) {
        code = ROOM_ALPHABET[value % ROOM_ALPHABET.length] + code;
        value = Math.floor(value / ROOM_ALPHABET.length);
      }
      if (this.rooms.has(code)) continue;
      this.rooms.set(code, { host, players: new Map() });
      this.members.set(host, { room: code });
      return [{ peer: host, message: { t: 'room', code } }];
    }
    return this.error(host, 'full');
  }

  join(peer: string, code: string, name: string, pid: string, now: number): Delivery[] {
    if (this.members.has(peer)) return this.error(peer, 'already-connected');
    const room = this.rooms.get(code);
    if (!room) return this.error(peer, 'no-room');
    if (!pid || !name.trim() || pid.length > 128 || name.length > 40) return this.error(peer, 'invalid-join');
    // A pid already in the room gets its own slot back, even after the hold expired, as long as
    // nobody else took it (then its record would have been replaced). A held slot is not free;
    // an expired one is, and its record is replaced when someone else takes it.
    const existing = [...room.players].find(([, player]) => player.pid === pid);
    const free = (candidate: number) => {
      const player = room.players.get(candidate);
      return !player || (!player.peer && now - (player.leftAt ?? now) >= SLOT_HOLD_MS);
    };
    const slot = existing?.[0] ?? Array.from({ length: SLOT_COUNT }, (_, i) => i + 1).find(free);
    if (!slot) return this.error(peer, 'full');
    const deliveries: Delivery[] = [];
    if (existing?.[1].peer) {
      const oldPeer = existing[1].peer;
      this.members.delete(oldPeer);
      deliveries.push(...this.error(oldPeer, 'rejoined'));
    }
    room.players.set(slot, { pid, name: name.trim(), peer });
    this.members.set(peer, { room: code, slot });
    deliveries.push(
      { peer, message: { t: 'joined', slot } },
      { peer: room.host, message: { t: 'player', slot, name: name.trim(), state: 'in', id: pid } },
    );
    return deliveries;
  }

  leave(peer: string, now: number): Delivery[] {
    const member = this.members.get(peer);
    if (!member) return [];
    this.members.delete(peer);
    const room = this.rooms.get(member.room)!;
    if (member.slot === undefined) {
      this.rooms.delete(member.room);
      const deliveries: Delivery[] = [];
      for (const player of room.players.values()) {
        if (!player.peer) continue;
        this.members.delete(player.peer);
        deliveries.push({ peer: player.peer, message: { t: 'host-gone' } });
      }
      return deliveries;
    }
    const player = room.players.get(member.slot)!;
    player.peer = undefined;
    player.leftAt = now;
    return [{ peer: room.host, message: {
      t: 'player', slot: member.slot, name: player.name, state: 'out', id: player.pid,
    } }];
  }

  forward(peer: string, message: WireMessage): Delivery[] {
    const member = this.members.get(peer);
    if (!member) return [];
    const room = this.rooms.get(member.room)!;
    if (member.slot !== undefined) {
      // A phone may only send phone messages: never 'player', 'room' or anything the host trusts from the relay.
      if (!PHONE_TYPES.includes(message.t)) return [];
      return [{ peer: room.host, message: { ...message, slot: member.slot } }];
    }
    if (typeof message.to !== 'number') return [];
    const target = room.players.get(message.to)?.peer;
    return target ? [{ peer: target, message: { ...message } }] : [];
  }

  private error(peer: string, reason: string): Delivery[] {
    return [{ peer, message: { t: 'error', reason } }];
  }
}

export interface RelayOptions {
  /** How often every socket is pinged; one that did not pong since the last ping is terminated. */
  heartbeatMs?: number;
}

export function attachRelay(httpServer: HttpServer, path = '/ws', options: RelayOptions = {}) {
  const rooms = new Rooms();
  const sockets = new Map<string, WebSocket>();
  const alive = new WeakSet<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const deliver = (messages: Delivery[]) => {
    for (const { peer, message } of messages) {
      const socket = sockets.get(peer);
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }
  };
  const upgrade: Parameters<HttpServer['on']>[1] = (request, socket, head) => {
    if (request.url?.split('?')[0] !== path) return;
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  };
  httpServer.on('upgrade', upgrade);
  wss.on('connection', (socket) => {
    const peer = randomUUID();
    sockets.set(peer, socket);
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
    socket.on('error', () => socket.close());
    socket.on('message', (data, binary) => {
      const message = binary ? null : parseMessage(data.toString());
      if (!message) {
        socket.send(JSON.stringify({ t: 'error', reason: 'invalid-message' }));
        return;
      }
      if (message.t === 'host') deliver(rooms.createRoom(peer));
      else if (message.t === 'join') {
        if (typeof message.room !== 'string' || typeof message.name !== 'string' || typeof message.pid !== 'string') {
          socket.send(JSON.stringify({ t: 'error', reason: 'invalid-join' }));
          return;
        }
        deliver(rooms.join(peer, message.room.toUpperCase(), message.name, message.pid, Date.now()));
      } else deliver(rooms.forward(peer, message));
    });
    socket.on('close', () => {
      sockets.delete(peer);
      deliver(rooms.leave(peer, Date.now()));
    });
  });
  // Liveness: a frozen page or a phone that left Wi-Fi keeps its TCP socket open for minutes.
  // Terminating it fires 'close', which frees the slot as for any other drop.
  const heartbeat = setInterval(() => {
    for (const socket of sockets.values()) {
      if (!alive.has(socket)) { socket.terminate(); continue; }
      alive.delete(socket);
      try { socket.ping(); } catch { socket.terminate(); }
    }
  }, options.heartbeatMs ?? RELAY_HEARTBEAT_MS);
  heartbeat.unref?.();
  const close = () => {
    clearInterval(heartbeat);
    httpServer.off('upgrade', upgrade);
    httpServer.off('close', close);
    for (const socket of sockets.values()) socket.terminate();
    wss.close();
  };
  httpServer.once('close', close);
  return { close, wss };
}
