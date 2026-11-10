// The Cloudflare Worker: routes relay WebSockets to one Durable Object per room and, when the
// `assets` binding is configured, serves the built site for every other path.
//
//   /ws/host          a host creates a room: the Worker picks a free code and its object
//   /ws/room/<code>   a phone joins, or a host resumes, the room with that code
//
// The Node adapter (server/relay.ts) accepts the same paths, so one client works against both.
import { CLOSE_CODES, ROOM_ALPHABET, isRoomCode, type ErrorReason } from '../src/shared/protocol';
import { AddressLimiter, endpointFor } from '../server/core';
import { roomStatus } from './room';
import { intVar, upgradeResponse, workers, type Env } from './types';

export { RelayRoom } from './room';

/** Codes tried for a new room before the Worker answers `busy`. */
const CREATE_TRIES = 8;

// Failed attempts per client address in this isolate: best effort only, because each isolate has
// its own table. A deployment adds a rate limiting rule on /ws/room/* as well (docs/v2/PROTOCOL.md).
let limiter: AddressLimiter | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const endpoint = endpointFor(url.pathname);
    if (!endpoint) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    if (endpoint.kind === 'legacy') return new Response('Use /ws/host or /ws/room/<code>', { status: 404 });

    limiter ??= new AddressLimiter(intVar(env.RELAY_ADDRESS_LIMIT));
    const addr = request.headers.get('CF-Connecting-IP') ?? '';
    const now = Date.now();
    if (limiter.blocked(addr, now)) return refuse('too-many-attempts');

    if (endpoint.kind === 'room') {
      if (!isRoomCode(endpoint.code)) { limiter.fail(addr, now); return refuse('no-room'); }
      const response = await roomObject(env, endpoint.code).fetch(forward(request, endpoint.code, 'room', addr));
      if (response.status === roomStatus.missing) { limiter.fail(addr, now); return refuse('no-room'); }
      return response;
    }
    for (let attempt = 0; attempt < CREATE_TRIES; attempt++) {
      const code = randomCode();
      const response = await roomObject(env, code).fetch(forward(request, code, 'create', addr));
      if (response.status !== roomStatus.taken) return response;
    }
    return refuse('busy');
  },
};

function roomObject(env: Env, code: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(code));
}

/** The upgrade request for the room object, with the relay headers set by the Worker (never by the client). */
function forward(request: Request, code: string, intent: 'create' | 'room', addr: string): Request {
  const headers = new Headers(request.headers);
  headers.set('x-relay-code', code);
  headers.set('x-relay-intent', intent);
  headers.set('x-relay-addr', addr);
  return new Request(request.url, { method: 'GET', headers });
}

/** Answer on a socket the Worker accepts itself, so a refusal looks the same as from the Node adapter. */
function refuse(reason: ErrorReason): Response {
  const pair = new workers.WebSocketPair();
  const server = pair[1];
  server.accept();
  server.send(JSON.stringify({ t: 'error', reason }));
  server.close(CLOSE_CODES.policy, reason);
  return upgradeResponse(pair[0]);
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let code = '';
  // 256 is not a multiple of 23: values from 230 up are redrawn so every letter is equally likely.
  for (let i = 0; code.length < 4; i++) {
    const byte = i < bytes.length ? bytes[i] : crypto.getRandomValues(new Uint8Array(1))[0];
    if (byte < 230) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
  }
  return code;
}
