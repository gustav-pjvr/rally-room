// The Node adapter: the relay core (server/core.ts) behind a `ws` server on the dev server's HTTP
// server. Paths (docs/v2/PROTOCOL.md): `/ws/host` creates a room, `/ws/room/<code>` joins or resumes
// one, and `/ws` is the v1 endpoint, kept here until the clients move to the v2 paths.
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomFillSync, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { MAX_FRAME_BYTES, RELAY_HEARTBEAT_MS } from '../src/shared/protocol';
import { RelayCore, endpointFor, type Action, type CoreOptions } from './core';

export { RelayCore, endpointFor } from './core';

export interface RelayOptions extends Partial<Omit<CoreOptions, 'randomBytes'>> {
  /** How often every socket is pinged (ws protocol ping); the core closes one silent for `idleMs`. */
  heartbeatMs?: number;
}

export function attachRelay(httpServer: HttpServer, path = '/ws', options: RelayOptions = {}) {
  const heartbeatMs = options.heartbeatMs ?? RELAY_HEARTBEAT_MS;
  const core = new RelayCore({
    idleMs: Math.round(heartbeatMs * 2.5),
    ...options,
    randomBytes: (length) => randomFillSync(new Uint8Array(length)),
  });
  const sockets = new Map<string, WebSocket>();
  // maxPayload: ws stops reading a bigger frame and closes the socket with 1009 without buffering it.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let revision = -1;

  const run = (actions: Action[]) => {
    for (const action of actions) {
      const socket = sockets.get(action.peer);
      if (!socket) continue;
      if (action.kind === 'send') {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(action.message));
      } else {
        sockets.delete(action.peer);
        socket.close(action.code, action.reason);
        // A peer that ignores the close handshake is cut off.
        setTimeout(() => socket.terminate(), 2000).unref?.();
      }
    }
    if (core.revision !== revision) arm();
  };
  // One timer for the next hold or handshake expiry, re-armed whenever the rooms change.
  const arm = () => {
    revision = core.revision;
    if (deadline) clearTimeout(deadline);
    deadline = undefined;
    const next = core.nextDeadline();
    if (next === undefined) return;
    deadline = setTimeout(() => { run(core.tick(Date.now())); arm(); }, Math.max(0, next - Date.now()) + 5);
    deadline.unref?.();
  };

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const endpoint = endpointFor(request.url, path);
    if (!endpoint) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      const peer = randomUUID();
      sockets.set(peer, ws);
      ws.on('pong', () => core.seen(peer, Date.now()));
      ws.on('error', () => ws.terminate());
      ws.on('message', (data, binary) => {
        if (!sockets.has(peer)) return;
        const text = binary ? null : (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('utf8');
        run(core.receive(peer, text, Date.now()));
      });
      ws.on('close', () => {
        sockets.delete(peer);
        run(core.close(peer, Date.now()));
      });
      run(core.open(peer, endpoint, Date.now(), request.socket.remoteAddress ?? ''));
    });
  };
  httpServer.on('upgrade', upgrade);

  // Liveness: a frozen page or a phone that left Wi-Fi keeps its TCP socket open for minutes. Every
  // socket is pinged; one the core has not heard from for idleMs is closed, which frees its place.
  const heartbeat = setInterval(() => {
    for (const socket of sockets.values()) {
      try { socket.ping(); } catch { socket.terminate(); }
    }
    run(core.tick(Date.now()));
  }, heartbeatMs);
  heartbeat.unref?.();

  const close = () => {
    clearInterval(heartbeat);
    if (deadline) clearTimeout(deadline);
    httpServer.off('upgrade', upgrade);
    httpServer.off('close', close);
    for (const socket of sockets.values()) socket.terminate();
    wss.close();
  };
  httpServer.once('close', close);
  return { close, wss, core };
}
