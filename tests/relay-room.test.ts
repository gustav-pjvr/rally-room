// The Durable Object adapter (worker/room.ts) driven through the hibernation interface the runtime
// uses, with an in-memory stand-in for its state. It proves what wrangler dev cannot show: a room
// survives the object being evicted and rebuilt while its sockets stay open. The full behaviour over
// real sockets runs under workerd in `npm run test:worker`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayRoom } from '../worker/room';
import type { DurableState, Env, HibernatableSocket } from '../worker/types';
import { HOST_HOLD_MS } from '../src/shared/protocol';

class FakeSocket implements HibernatableSocket {
  sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | undefined;
  private attachment: unknown = null;
  send(data: string) { if (!this.closed) this.sent.push(JSON.parse(data)); }
  close(code?: number, reason?: string) { this.closed ??= { code, reason }; }
  serializeAttachment(value: unknown) { this.attachment = JSON.parse(JSON.stringify(value)); }
  deserializeAttachment() { return this.attachment; }
  take(t: string) { const out = this.sent.filter((m) => m.t === t); this.sent = this.sent.filter((m) => m.t !== t); return out; }
}

/** What the runtime keeps across an eviction: storage, the alarm and the accepted sockets. */
class FakeState implements DurableState {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  sockets: FakeSocket[] = [];
  answered = new Map<HibernatableSocket, Date>();
  ready: Promise<unknown> = Promise.resolve();
  storage = {
    get: async <T>(key: string) => this.data.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { this.data.set(key, JSON.parse(JSON.stringify(value))); },
    deleteAll: async () => { this.data.clear(); },
    getAlarm: async () => this.alarm,
    setAlarm: async (time: number) => { this.alarm = time; },
    deleteAlarm: async () => { this.alarm = null; },
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>) { const p = callback(); this.ready = p; return p; }
  acceptWebSocket(socket: HibernatableSocket) { this.sockets.push(socket as FakeSocket); }
  getWebSockets() { return this.sockets.filter((s) => !s.closed); }
  setWebSocketAutoResponse() { /* answered by the runtime; see `answered` */ }
  getWebSocketAutoResponseTimestamp(socket: HibernatableSocket) { return this.answered.get(socket) ?? null; }
}

const env = {} as Env;
const json = (m: object) => JSON.stringify(m);

async function wake(state: FakeState) {
  const room = new RelayRoom(state, env);
  await state.ready;
  return room;
}

describe('durable object adapter: hibernation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    (globalThis as Record<string, unknown>).WebSocketRequestResponsePair = class { constructor(public request: string, public response: string) {} };
  });
  afterEach(() => vi.useRealTimers());

  it('keeps the room, its players and its key across evictions', async () => {
    const state = new FakeState();
    let room = await wake(state);
    const host = new FakeSocket();
    await room.connect(host, 'KMNP', { kind: 'create' }, 'a1');
    await room.webSocketMessage(host, json({ t: 'host' }));
    const { code, key } = host.take('room')[0] as { code: string; key: string };
    expect(code).toBe('KMNP');
    const phone = new FakeSocket();
    await room.connect(phone, 'KMNP', { kind: 'room', code }, 'a2');
    await room.webSocketMessage(phone, json({ t: 'join', room: code, name: 'Ann', pid: 'pid-a' }));
    expect(phone.take('joined')).toEqual([{ t: 'joined', slot: 1 }]);
    host.take('player');

    // Evicted: a new object instance with the same storage and sockets.
    room = await wake(state);
    await room.webSocketMessage(phone, json({ t: 'pong', h: 1, p: 2 }));
    expect(host.take('pong')).toEqual([{ t: 'pong', h: 1, p: 2, slot: 1 }]);

    // The host drops; the hold is on the alarm; the object is evicted again during the hold.
    await room.webSocketClose(host);
    expect(phone.take('host-away')).toEqual([{ t: 'host-away' }]);
    expect(state.alarm).not.toBeNull();
    room = await wake(state);
    const back = new FakeSocket();
    await room.connect(back, 'KMNP', { kind: 'room', code }, 'a1');
    await room.webSocketMessage(back, json({ t: 'host', resume: { code, key } }));
    expect(back.take('room')[0]).toMatchObject({ code, resumed: true });
    expect(back.take('player')).toEqual([{ t: 'player', slot: 1, name: 'Ann', state: 'in', id: 'pid-a' }]);
    expect(phone.take('host-back')).toEqual([{ t: 'host-back' }]);
  });

  it('closes the held room on the alarm after the hold, and forgets everything', async () => {
    const state = new FakeState();
    let room = await wake(state);
    const host = new FakeSocket();
    await room.connect(host, 'QRST', { kind: 'create' }, '');
    await room.webSocketMessage(host, json({ t: 'host' }));
    const phone = new FakeSocket();
    await room.connect(phone, 'QRST', { kind: 'room', code: 'QRST' }, '');
    await room.webSocketMessage(phone, json({ t: 'join', room: 'QRST', name: 'Ann', pid: 'pid-a' }));
    await room.webSocketClose(host);
    vi.setSystemTime(1_000_000 + HOST_HOLD_MS + 10);
    // The phone kept itself alive with auto-answered heartbeats while the object slept.
    state.answered.set(phone, new Date(1_000_000 + HOST_HOLD_MS));
    room = await wake(state);
    await room.alarm();
    expect(phone.take('host-gone')).toEqual([{ t: 'host-gone' }]);
    expect(phone.closed?.code).toBe(4001);
    expect(state.data.size).toBe(0);
    expect(state.alarm).toBeNull();
  });

  it('treats a socket that vanished during an eviction as closed', async () => {
    const state = new FakeState();
    let room = await wake(state);
    const host = new FakeSocket();
    await room.connect(host, 'WXYZ', { kind: 'create' }, '');
    await room.webSocketMessage(host, json({ t: 'host' }));
    const phone = new FakeSocket();
    await room.connect(phone, 'WXYZ', { kind: 'room', code: 'WXYZ' }, '');
    await room.webSocketMessage(phone, json({ t: 'join', room: 'WXYZ', name: 'Ann', pid: 'pid-a' }));
    host.take('player');
    state.sockets = state.sockets.filter((s) => s !== phone);
    room = await wake(state);
    expect(host.take('player')).toEqual([{ t: 'player', slot: 1, name: 'Ann', state: 'out', id: 'pid-a' }]);
    void room;
  });

  it('answers 409 for a taken code and 404 for a missing room, so the Worker can pick another or refuse', async () => {
    const state = new FakeState();
    const room = await wake(state);
    const upgrade = (intent: string, code = 'KMNP') => new Request('http://relay/ws', {
      headers: { Upgrade: 'websocket', 'x-relay-code': code, 'x-relay-intent': intent },
    });
    expect((await room.fetch(upgrade('room'))).status).toBe(404);
    const host = new FakeSocket();
    await room.connect(host, 'KMNP', { kind: 'create' }, '');
    expect((await room.fetch(upgrade('create'))).status).toBe(409);
    expect((await room.fetch(upgrade('create', 'ABCD'))).status).toBe(400);
    expect((await room.fetch(upgrade('other'))).status).toBe(400);
    expect((await room.fetch(new Request('http://relay/ws'))).status).toBe(426);
  });
});
