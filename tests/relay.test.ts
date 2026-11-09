import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Rooms, attachRelay } from '../server/relay';
import { SLOT_HOLD_MS } from '../src/shared/protocol';

describe('room logic', () => {
  it('creates a 4-letter room and assigns slots 1 to 4, then reports full', () => {
    const r = new Rooms(() => 0.5);
    const code = r.createRoom('h')[0].message.code as string;
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    for (let i = 1; i <= 4; i++) {
      const out = r.join(`p${i}`, code, `P${i}`, `pid${i}`, 0);
      expect(out[0].message).toEqual({ t: 'joined', slot: i });
      expect(out[1]).toEqual({ peer: 'h', message: { t: 'player', slot: i, name: `P${i}`, state: 'in', id: `pid${i}` } });
    }
    expect(r.join('p5', code, 'P5', 'pid5', 0)[0].message).toEqual({ t: 'error', reason: 'full' });
    expect(r.join('x', 'ZZZZ', 'X', 'pidx', 0)[0].message).toEqual({ t: 'error', reason: 'no-room' });
  });

  it('holds a slot for the same pid and frees it after the hold', () => {
    const r = new Rooms();
    const code = r.createRoom('h')[0].message.code as string;
    r.join('a', code, 'Ann', 'pidA', 0);
    expect(r.leave('a', 1000)[0].message).toMatchObject({ t: 'player', slot: 1, state: 'out' });
    // A new player gets slot 2, because slot 1 is held for Ann.
    expect(r.join('b', code, 'Ben', 'pidB', 2000)[0].message).toEqual({ t: 'joined', slot: 2 });
    expect(r.join('a2', code, 'Ann', 'pidA', 3000)[0].message).toEqual({ t: 'joined', slot: 1 });
    r.leave('a2', 4000);
    expect(r.join('c', code, 'Cat', 'pidC', 4000 + SLOT_HOLD_MS)[0].message).toEqual({ t: 'joined', slot: 1 });
  });

  it('forwards phone messages to the host with the slot, and host messages to one slot', () => {
    const r = new Rooms();
    const code = r.createRoom('h')[0].message.code as string;
    r.join('a', code, 'Ann', 'pidA', 0);
    r.join('b', code, 'Ben', 'pidB', 0);
    expect(r.forward('b', { t: 'swing', power: 1 })).toEqual([{ peer: 'h', message: { t: 'swing', power: 1, slot: 2 } }]);
    expect(r.forward('h', { t: 'ping', to: 1, h: 5 })).toEqual([{ peer: 'a', message: { t: 'ping', to: 1, h: 5 } }]);
    expect(r.forward('h', { t: 'ping', h: 5 })).toEqual([]);
    expect(r.leave('h', 0).map((d) => d.message.t)).toEqual(['host-gone', 'host-gone']);
  });

  it('gives a returning pid its old slot after the hold expired, while the slot is free', () => {
    const r = new Rooms();
    const code = r.createRoom('h')[0].message.code as string;
    r.join('a', code, 'Ann', 'pidA', 0);
    r.join('b', code, 'Ben', 'pidB', 0);
    r.leave('a', 1000);
    // Ann comes back long after the 60 s hold: slot 1 is still free, so it is hers again.
    const out = r.join('a2', code, 'Ann', 'pidA', 1000 + SLOT_HOLD_MS + 5000);
    expect(out[0].message).toEqual({ t: 'joined', slot: 1 });
    expect(out[1].message).toEqual({ t: 'player', slot: 1, name: 'Ann', state: 'in', id: 'pidA' });
  });

  it('gives a returning pid a free slot when someone else took its old one', () => {
    const r = new Rooms();
    const code = r.createRoom('h')[0].message.code as string;
    r.join('a', code, 'Ann', 'pidA', 0);
    r.leave('a', 1000);
    expect(r.join('c', code, 'Cat', 'pidC', 1000 + SLOT_HOLD_MS)[0].message).toEqual({ t: 'joined', slot: 1 });
    const out = r.join('a2', code, 'Ann', 'pidA', 2000 + SLOT_HOLD_MS);
    expect(out[0].message).toEqual({ t: 'joined', slot: 2 });
    expect(out[1].message).toMatchObject({ slot: 2, id: 'pidA', state: 'in' });
    // Cat keeps slot 1.
    expect(r.forward('c', { t: 'swing', power: 1 })[0].message).toMatchObject({ slot: 1 });
  });

  it('sends the pid as id in player out messages', () => {
    const r = new Rooms();
    const code = r.createRoom('h')[0].message.code as string;
    r.join('a', code, 'Ann', 'pidA', 0);
    expect(r.leave('a', 10)[0].message).toEqual({ t: 'player', slot: 1, name: 'Ann', state: 'out', id: 'pidA' });
  });

  it('forwards only phone message types from a phone', () => {
    const r = new Rooms();
    const code = r.createRoom('h')[0].message.code as string;
    r.join('a', code, 'Ann', 'pidA', 0);
    for (const t of ['swing', 'raw', 'status', 'pong', 'player-info', 'profile']) {
      expect(r.forward('a', { t })).toEqual([{ peer: 'h', message: { t, slot: 1 } }]);
    }
    for (const t of ['player', 'room', 'ping', 'mode', 'you', 'game', 'hit', 'host', 'join', 'error']) {
      expect(r.forward('a', { t, state: 'out', code: 'ZZZZ' })).toEqual([]);
    }
  });
});

describe('ws adapter', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  function client(url: string) {
    const ws = new WebSocket(url);
    const inbox: Record<string, unknown>[] = [];
    const waiters: (() => void)[] = [];
    ws.on('message', (d) => {
      inbox.push(JSON.parse(d.toString()));
      waiters.splice(0).forEach((w) => w());
    });
    const next = async (t: string) => {
      for (;;) {
        const i = inbox.findIndex((m) => m.t === t);
        if (i >= 0) return inbox.splice(i, 1)[0];
        await new Promise<void>((r) => waiters.push(r));
      }
    };
    const open = new Promise<void>((r) => ws.on('open', () => r()));
    return { ws, next, open, send: (m: object) => ws.send(JSON.stringify(m)) };
  }

  it('relays join, phone-to-host and host-to-slot messages over real sockets', async () => {
    server = createServer();
    attachRelay(server, '/ws');
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;

    const host = client(url);
    await host.open;
    host.send({ t: 'host' });
    const { code } = await host.next('room');

    const phone = client(url);
    await phone.open;
    phone.send({ t: 'join', room: String(code).toLowerCase(), name: 'Gus', pid: 'p1' });
    expect(await phone.next('joined')).toEqual({ t: 'joined', slot: 1 });
    expect(await host.next('player')).toMatchObject({ slot: 1, name: 'Gus', state: 'in' });

    phone.send({ t: 'swing', power: 0.5 });
    expect(await host.next('swing')).toEqual({ t: 'swing', power: 0.5, slot: 1 });

    host.send({ t: 'ping', to: 1, h: 42 });
    expect(await phone.next('ping')).toEqual({ t: 'ping', to: 1, h: 42 });

    phone.send({ nope: true });
    expect(await phone.next('error')).toEqual({ t: 'error', reason: 'invalid-message' });

    host.ws.close();
    expect(await phone.next('host-gone')).toEqual({ t: 'host-gone' });
    phone.ws.close();
  });

  it('pings sockets and terminates one that stops answering, which frees its slot', async () => {
    server = createServer();
    attachRelay(server, '/ws', { heartbeatMs: 60 });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;

    const host = client(url);
    await host.open;
    host.send({ t: 'host' });
    const { code } = await host.next('room');

    // A phone whose page froze: the socket is open but nothing answers pings.
    const silent = new WebSocket(url, { autoPong: false });
    await new Promise<void>((r) => silent.on('open', () => r()));
    silent.send(JSON.stringify({ t: 'join', room: code, name: 'Sil', pid: 'ps' }));
    expect(await host.next('player')).toMatchObject({ slot: 1, state: 'in', id: 'ps' });
    const closed = new Promise<void>((r) => silent.on('close', () => r()));
    expect(await host.next('player')).toMatchObject({ slot: 1, state: 'out', id: 'ps' });
    await closed;
    // The host answers pings (ws does by default) and is still connected after several rounds.
    await new Promise((r) => setTimeout(r, 300));
    expect(host.ws.readyState).toBe(WebSocket.OPEN);
    host.ws.close();
  });
});
