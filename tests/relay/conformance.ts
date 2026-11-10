// One behaviour and safety suite for every relay adapter, over real WebSockets. An adapter test
// file calls relayConformance with a way to start a relay on an ephemeral port:
//   tests/relay-node.test.ts   the Node `ws` adapter (runs in `npm run verify`)
//   tests/relay/worker.suite.ts the Cloudflare Worker and Durable Object under local workerd
//                               (`npm run test:worker`)
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CLOSE_CODES, MAX_FAILED_JOINS, MAX_FRAME_BYTES, PHONE_MESSAGE_BYTES } from '../../src/shared/protocol';
import { padTo, sleep, testClient, type TestClient } from './helpers';

export interface RelaySettings {
  hostHoldMs: number;
  handshakeMs: number;
  idleMs: number;
  /** Failed attempts one address may make (high for the main suite, low for its own test). */
  addressLimit: number;
}
export interface RelayHandle {
  /** `ws://127.0.0.1:<port>` */
  base: string;
  close(): Promise<void>;
}
export type StartRelay = (settings: RelaySettings) => Promise<RelayHandle>;

export const SETTINGS: RelaySettings = { hostHoldMs: 700, handshakeMs: 900, idleMs: 1500, addressLimit: 10_000 };

const SWING = { t: 'swing', tp: 1, power: 0.5, omega: 900, spin: 0, dir: 1, dur: 100 };

export function relayConformance(name: string, start: StartRelay, settings: RelaySettings = SETTINGS) {
  describe(`relay conformance: ${name}`, () => {
    let relay: RelayHandle;
    const clients: TestClient[] = [];
    beforeAll(async () => { relay = await start(settings); }, 120_000);
    afterAll(async () => { await relay?.close(); }, 30_000);
    afterEach(() => { for (const c of clients.splice(0)) c.close(); });

    const open = async (path: string, options?: Parameters<typeof testClient>[1]) => {
      const c = testClient(relay.base + path, options);
      clients.push(c);
      await c.opened;
      return c;
    };
    const newRoom = async () => {
      const host = await open('/ws/host');
      host.send({ t: 'host' });
      const room = await host.next('room');
      return { host, code: String(room.code), key: String(room.key) };
    };
    const newPhone = async (code: string, pid: string, name = pid.toUpperCase(), options?: Parameters<typeof testClient>[1]) => {
      const phone = await open(`/ws/room/${code}`, options);
      phone.send({ t: 'join', room: code, name, pid });
      const joined = await phone.next('joined');
      return { phone, slot: Number(joined.slot) };
    };
    /** Send a sentinel from a phone and wait for it at the host: everything sent before it has been handled. */
    const flush = async (phone: TestClient, host: TestClient) => {
      phone.send({ t: 'pong', h: 424242, p: 1 });
      for (;;) {
        const m = await host.next('pong');
        if (m.h === 424242) return;
      }
    };
    const unexpected = (host: TestClient, allowed: string[] = ['hb']) => host.inbox.filter((m) => !allowed.includes(m.t));

    it('creates a room on /ws/host and relays between host and phones', async () => {
      const { host, code, key } = await newRoom();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
      expect(key).toMatch(/^[0-9a-f]{32}$/);
      // Codes are case-insensitive in the path and in the join.
      const phone = await open(`/ws/room/${code.toLowerCase()}`);
      phone.send({ t: 'join', room: code.toLowerCase(), name: 'Ann', pid: 'pid-a' });
      expect(await phone.next('joined')).toEqual({ t: 'joined', slot: 1 });
      expect(await host.next('player')).toEqual({ t: 'player', slot: 1, name: 'Ann', state: 'in', id: 'pid-a' });
      phone.send(SWING);
      expect(await host.next('swing')).toEqual({ ...SWING, slot: 1 });
      host.send({ t: 'ping', to: 1, h: 42 });
      expect(await phone.next('ping')).toEqual({ t: 'ping', to: 1, h: 42 });
      phone.send('{"t":"hb"}');
      expect(await phone.next('hb')).toEqual({ t: 'hb' });
    });

    it('holds a slot for its pid, gives it back, and tells a replaced socket rejoined', async () => {
      const { host, code } = await newRoom();
      const a = await newPhone(code, 'pid-a');
      const b = await newPhone(code, 'pid-b');
      expect([a.slot, b.slot]).toEqual([1, 2]);
      a.phone.close();
      await host.next('player');
      await host.next('player');
      expect(await host.next('player')).toMatchObject({ slot: 1, state: 'out', id: 'pid-a' });
      expect((await newPhone(code, 'pid-c')).slot).toBe(3);
      const back = await newPhone(code, 'pid-a');
      expect(back.slot).toBe(1);
      const again = await newPhone(code, 'pid-a');
      expect(again.slot).toBe(1);
      expect(await back.phone.next('error')).toEqual({ t: 'error', reason: 'rejoined' });
    });

    it('rejects a second host or join on the same socket and the wrong job for an endpoint', async () => {
      const { host, code } = await newRoom();
      host.send({ t: 'host' });
      expect(await host.next('error')).toEqual({ t: 'error', reason: 'already-connected' });
      const { phone } = await newPhone(code, 'pid-a');
      phone.send({ t: 'join', room: code, name: 'A', pid: 'pid-a' });
      expect(await phone.next('error')).toEqual({ t: 'error', reason: 'already-connected' });
      const creator = await open('/ws/host');
      creator.send({ t: 'join', room: code, name: 'X', pid: 'x' });
      expect(await creator.next('error')).toEqual({ t: 'error', reason: 'wrong-endpoint' });
      const squatter = await open(`/ws/room/${code}`);
      squatter.send({ t: 'host' });
      expect(await squatter.next('error')).toEqual({ t: 'error', reason: 'wrong-endpoint' });
    });

    it('refuses a socket for a missing room or a malformed code', async () => {
      for (const path of ['/ws/room/ZQZQ', '/ws/room/ab1', '/ws/room/%00%01']) {
        const c = await open(path);
        expect(await c.next('error')).toEqual({ t: 'error', reason: 'no-room' });
        expect((await c.closed).code).toBe(CLOSE_CODES.policy);
      }
    });

    it('keeps rooms isolated', async () => {
      const A = await newRoom();
      const B = await newRoom();
      const a1 = await newPhone(A.code, 'same-pid');
      const b1 = await newPhone(B.code, 'same-pid');
      await A.host.next('player');
      await B.host.next('player');
      a1.phone.send(SWING);
      expect(await A.host.next('swing')).toMatchObject({ slot: 1 });
      A.host.send({ t: 'ping', to: 1, h: 7 });
      expect(await a1.phone.next('ping')).toMatchObject({ h: 7 });
      B.host.send({ t: 'ping', to: 1, h: 8 });
      expect(await b1.phone.next('ping')).toMatchObject({ h: 8 });
      // A phone that opened room A cannot join room B on that socket.
      const crosser = await open(`/ws/room/${A.code}`);
      crosser.send({ t: 'join', room: B.code, name: 'X', pid: 'x' });
      expect(await crosser.next('error')).toEqual({ t: 'error', reason: 'no-room' });
      await flush(a1.phone, A.host);
      await flush(b1.phone, B.host);
      expect(unexpected(B.host)).toEqual([]);
      expect(a1.phone.inbox.filter((m) => m.t === 'ping')).toEqual([]);
      expect(b1.phone.inbox.filter((m) => m.t === 'ping' || m.t === 'swing')).toEqual([]);
    });

    it('never forwards a forged relay type, and overwrites slot, to and id', async () => {
      const { host, code } = await newRoom();
      const { phone } = await newPhone(code, 'pid-a', 'A');
      await host.next('player');
      for (const t of ['player', 'room', 'joined', 'error', 'host-gone', 'host-away', 'host-back', 'ping', 'mode', 'game']) {
        phone.send({ t, slot: 1, state: 'out', name: 'A', id: 'pid-a', code: 'ZZZZ', reason: 'x', to: 1 });
      }
      phone.send({ ...SWING, slot: 4, to: 3, id: 'forged' });
      expect(await host.next('swing')).toEqual({ ...SWING, slot: 1 });
      await flush(phone, host);
      expect(unexpected(host)).toEqual([]);
    });

    it('enforces the per-type caps and closes a socket on a frame over the hard cap', async () => {
      const { host, code } = await newRoom();
      const { phone } = await newPhone(code, 'pid-a');
      await host.next('player');
      phone.send(padTo(SWING, PHONE_MESSAGE_BYTES.swing + 1));
      expect(await phone.next('error')).toEqual({ t: 'error', reason: 'too-big' });
      phone.send(padTo({ t: 'trace', n: 1 }, 9 * 1024));
      expect(await host.next('trace')).toMatchObject({ n: 1, slot: 1 });
      phone.send(padTo({ t: 'trace', n: 2 }, PHONE_MESSAGE_BYTES.trace + 1));
      expect(await phone.next('error')).toEqual({ t: 'error', reason: 'too-big' });
      host.send(padTo({ t: 'game', to: 1 }, 4097));
      expect(await host.next('error')).toEqual({ t: 'error', reason: 'too-big' });
      await flush(phone, host);
      expect(unexpected(host)).toEqual([]);
      phone.send(padTo({ t: 'trace', n: 3 }, MAX_FRAME_BYTES + 1));
      expect((await phone.closed).code).toBe(CLOSE_CODES.tooBig);
      expect(await host.next('player')).toMatchObject({ slot: 1, state: 'out' });
    });

    it('passes real lab traffic untouched', async () => {
      const { host, code } = await newRoom();
      const { phone } = await newPhone(code, 'pid-lab');
      await host.next('player');
      const sample = [123456.789, -9.80665016, 0.1234567, 3.14159265, -0.98765432, 9.80665016, 0.00123457, 812.345678, -456.789012, 23.4567890];
      let sent = 0;
      const startAt = Date.now();
      for (let tick = 0; Date.now() - startAt < 1500; tick++) {
        phone.send({ t: 'raw', s: [sample, sample, sample, sample] });
        sent++;
        if (tick % 10 === 0) {
          phone.send(SWING);
          phone.send(padTo({ t: 'trace' }, 8 * 1024));
          phone.send({ t: 'profile', mode: 'gyro', axes: 'x,y,z' });
          sent += 3;
        }
        await sleep(1000 / 15);
      }
      await flush(phone, host);
      const got = host.inbox.filter((m) => ['raw', 'swing', 'trace', 'profile'].includes(m.t));
      expect(got.length).toBe(sent);
      expect(phone.inbox.filter((m) => m.t === 'error')).toEqual([]);
    });

    it('drops a flood and closes the socket that sends it', async () => {
      const { host, code } = await newRoom();
      const { phone } = await newPhone(code, 'pid-flood');
      await host.next('player');
      for (let i = 0; i < 400; i++) phone.send({ t: 'pong', h: i, p: 0 });
      expect((await phone.closed).code).toBe(CLOSE_CODES.policy);
      expect(await host.next('player')).toMatchObject({ state: 'out', id: 'pid-flood' });
      const pongs = host.inbox.filter((m) => m.t === 'pong').length;
      // The burst (less the join and a few keepalives) passes; the flood behind it does not.
      expect(pongs).toBeGreaterThanOrEqual(70);
      expect(pongs).toBeLessThan(120);
    });

    it('closes a socket after too many failed joins or wrong keys', async () => {
      const { code, key } = await newRoom();
      const guesser = await open(`/ws/room/${code}`);
      for (let i = 0; i < MAX_FAILED_JOINS; i++) guesser.send({ t: 'join', room: 'QZQZ', name: 'G', pid: 'g' });
      for (let i = 0; i < MAX_FAILED_JOINS; i++) expect(await guesser.next('error')).toEqual({ t: 'error', reason: 'no-room' });
      expect(await guesser.next('error')).toEqual({ t: 'error', reason: 'too-many-attempts' });
      expect((await guesser.closed).code).toBe(CLOSE_CODES.policy);
      const thief = await open(`/ws/room/${code}`);
      for (let i = 0; i < MAX_FAILED_JOINS; i++) thief.send({ t: 'host', resume: { code, key: key.replace(/./, (c) => (c === 'a' ? 'b' : 'a')) } });
      for (let i = 0; i < MAX_FAILED_JOINS; i++) expect(await thief.next('error')).toEqual({ t: 'error', reason: 'bad-key' });
      expect((await thief.closed).code).toBe(CLOSE_CODES.policy);
    });

    it('survives malformed input and forwards none of it', async () => {
      const { host, code } = await newRoom();
      const { phone } = await newPhone(code, 'pid-a');
      await host.next('player');
      const frames: (string | Buffer)[] = [
        Buffer.from([0, 1, 2, 255]), 'not json', '[1,2]', '"x"', '{"t":5}', '{"no":1}',
        '['.repeat(5000) + ']'.repeat(5000),
        '{"t":"profile","__proto__":{"polluted":1}}',
        '{"t":"profile","constructor":{"prototype":{"x":1}}}',
        '{"t":"swing","tp":1e999,"power":0.5,"omega":900,"spin":0,"dir":1,"dur":100}',
        JSON.stringify({ t: 'profile', s: 'y'.repeat(3000) }),
        JSON.stringify({ t: 'profile', s: 'ctl\u0001' }),
        JSON.stringify({ t: 'raw', s: 'not samples' }),
      ];
      for (const frame of frames) phone.send(frame);
      await flush(phone, host);
      expect(unexpected(host)).toEqual([]);
      // Each bad frame got its own error (the phone's replies travel on its own socket, so wait for them).
      for (const _frame of frames) expect(await phone.next('error')).toEqual({ t: 'error', reason: 'invalid-message' });
      // The host's own junk is survived too.
      for (const frame of frames) host.send(frame);
      await host.collect('error', 300);
      const join = await open(`/ws/room/${code}`);
      join.send({ t: 'join', room: code, name: 'Bad\u202eName', pid: 'p-bad' });
      expect(await join.next('error')).toEqual({ t: 'error', reason: 'invalid-join' });
      const fresh = await newPhone(code, 'pid-fresh');
      expect(fresh.slot).toBe(2);
      phone.send(SWING);
      expect(await host.next('swing')).toEqual({ ...SWING, slot: 1 });
    });

    it('holds the room for its host and resumes it with the right key only', async () => {
      const { host, code, key } = await newRoom();
      const { phone } = await newPhone(code, 'pid-a', 'A');
      host.close();
      expect(await phone.next('host-away')).toEqual({ t: 'host-away' });
      const wrong = await open(`/ws/room/${code}`);
      wrong.send({ t: 'host', resume: { code, key: '0'.repeat(32) } });
      expect(await wrong.next('error')).toEqual({ t: 'error', reason: 'bad-key' });
      const back = await open(`/ws/room/${code}`);
      back.send({ t: 'host', resume: { code, key } });
      const room = await back.next('room');
      expect(room).toMatchObject({ t: 'room', code, resumed: true });
      expect(room.key).not.toBe(key);
      expect(await back.next('player')).toEqual({ t: 'player', slot: 1, name: 'A', state: 'in', id: 'pid-a' });
      expect(await phone.next('host-back')).toEqual({ t: 'host-back' });
      phone.send(SWING);
      expect(await back.next('swing')).toEqual({ ...SWING, slot: 1 });
      // After the hold the room closes: phones get host-gone and the code is gone.
      back.close();
      await phone.next('host-away');
      expect(await phone.next('host-gone', settings.hostHoldMs + 3000)).toEqual({ t: 'host-gone' });
      expect((await phone.closed).code).toBe(CLOSE_CODES.roomClosed);
      const late = await open(`/ws/room/${code}`);
      expect(await late.next('error')).toEqual({ t: 'error', reason: 'no-room' });
    });

    it('closes a socket that never finishes its handshake, and a member that goes silent', async () => {
      const { host, code } = await newRoom();
      const lurker = await open(`/ws/room/${code}`);
      const silent = await newPhone(code, 'pid-silent', 'S', { heartbeatMs: 0, autoPong: false });
      await host.next('player');
      expect((await lurker.closed).code).toBe(CLOSE_CODES.idle);
      expect((await silent.phone.closed).code).toBe(CLOSE_CODES.idle);
      expect(await host.next('player')).toMatchObject({ state: 'out', id: 'pid-silent' });
      expect(host.ws.readyState).toBe(host.ws.OPEN);
    });
  });

  describe(`relay conformance: ${name}, failed attempts per address`, () => {
    let relay: RelayHandle;
    beforeAll(async () => { relay = await start({ ...settings, addressLimit: 3 }); }, 120_000);
    afterAll(async () => { await relay?.close(); }, 30_000);

    it('refuses an address that keeps naming missing rooms', async () => {
      const reasons: string[] = [];
      for (let i = 0; i < 4; i++) {
        const c = testClient(`${relay.base}/ws/room/QZQ${'ABCD'[i]}`);
        await c.opened;
        reasons.push(String((await c.next('error')).reason));
        await c.closed;
      }
      expect(reasons).toEqual(['no-room', 'no-room', 'no-room', 'too-many-attempts']);
    });
  });
}
