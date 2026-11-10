// Unit tests of the pure relay core (server/core.ts): room rules, limits and safety, with time and
// randomness injected. The same behaviour over real sockets, against both adapters, is in
// tests/relay/conformance.ts (run by tests/relay-node.test.ts and `npm run test:worker`).
import { describe, expect, it } from 'vitest';
import { AddressLimiter, RelayCore, endpointFor, safeEqual, type Action, type CoreOptions, type Endpoint } from '../server/core';
import {
  CLOSE_CODES, CONTROL_MESSAGE_BYTES, HOST_HOLD_MS, HOST_MESSAGE_BYTES, IDLE_MS, MAX_FAILED_JOINS, MAX_FRAME_BYTES,
  PHONE_MESSAGE_BYTES, PHONE_TYPES, RATE_LIMITS, SLOT_HOLD_MS, isSafeValue, utf8Length, type WireMessage,
} from '../src/shared/protocol';
import { padTo, seededBytes } from './relay/helpers';

const CREATE: Endpoint = { kind: 'create' };
const LEGACY: Endpoint = { kind: 'legacy' };
const room = (code: string): Endpoint => ({ kind: 'room', code });

function make(options: Partial<CoreOptions> = {}) {
  return new RelayCore({ randomBytes: seededBytes(7), ...options });
}
const sends = (actions: Action[], peer?: string) => actions
  .filter((a): a is Extract<Action, { kind: 'send' }> => a.kind === 'send' && (peer === undefined || a.peer === peer))
  .map((a) => a.message);
const closes = (actions: Action[]) => actions.filter((a): a is Extract<Action, { kind: 'close' }> => a.kind === 'close');
const json = (m: object) => JSON.stringify(m);

/** Open a host on /ws/host and create its room. */
function host(core: RelayCore, peer = 'h', now = 0) {
  core.open(peer, CREATE, now, 'host-addr');
  const message = sends(core.receive(peer, json({ t: 'host' }), now), peer)[0];
  return { code: String(message.code), key: String(message.key) };
}
/** Open a phone on /ws/room/<code> and join. */
function phone(core: RelayCore, code: string, peer: string, pid: string, now = 0, name = peer.toUpperCase()) {
  core.open(peer, room(code), now, `addr-${peer}`);
  return core.receive(peer, json({ t: 'join', room: code, name, pid }), now);
}
const SWING = { t: 'swing', tp: 1, power: 0.5, omega: 900, spin: 0, dir: 1, dur: 100 };

describe('relay core: rooms and slots', () => {
  it('creates a room with a 4-letter code and a 128-bit key from the injected source', () => {
    const core = make();
    const a = host(core, 'h1');
    const b = host(core, 'h2');
    expect(a.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    expect(a.key).toMatch(/^[0-9a-f]{32}$/);
    expect(b.code).not.toBe(a.code);
    expect(b.key).not.toBe(a.key);
    // The key is exactly the injected bytes in hex.
    const fixed = new RelayCore({ randomBytes: (n) => new Uint8Array(n).fill(0xab) });
    fixed.open('h', CREATE, 0);
    expect(sends(fixed.receive('h', json({ t: 'host' }), 0))[0].key).toBe('ab'.repeat(16));
  });

  it('assigns slots 1 to 4, reports full, and sends the host player in with the pid as id', () => {
    const core = make();
    const { code } = host(core);
    for (let i = 1; i <= 4; i++) {
      const out = phone(core, code, `p${i}`, `pid${i}`);
      expect(sends(out, `p${i}`)).toEqual([{ t: 'joined', slot: i }]);
      expect(sends(out, 'h')).toEqual([{ t: 'player', slot: i, name: `P${i}`, state: 'in', id: `pid${i}` }]);
    }
    expect(sends(phone(core, code, 'p5', 'pid5'), 'p5')).toEqual([{ t: 'error', reason: 'full' }]);
  });

  it('holds a slot for the same pid and frees it after the hold', () => {
    const core = make();
    const { code } = host(core);
    phone(core, code, 'a', 'pidA');
    expect(sends(core.close('a', 1000), 'h')).toEqual([{ t: 'player', slot: 1, name: 'A', state: 'out', id: 'pidA' }]);
    expect(sends(phone(core, code, 'b', 'pidB', 2000), 'b')).toEqual([{ t: 'joined', slot: 2 }]);
    expect(sends(phone(core, code, 'a2', 'pidA', 3000), 'a2')).toEqual([{ t: 'joined', slot: 1 }]);
    core.close('a2', 4000);
    expect(sends(phone(core, code, 'c', 'pidC', 4000 + SLOT_HOLD_MS), 'c')).toEqual([{ t: 'joined', slot: 1 }]);
  });

  it('gives a returning pid its old slot after the hold while free, or a free slot when taken', () => {
    const core = make();
    const { code } = host(core);
    phone(core, code, 'a', 'pidA');
    phone(core, code, 'b', 'pidB');
    core.close('a', 1000);
    expect(sends(phone(core, code, 'a2', 'pidA', 1000 + SLOT_HOLD_MS + 5000), 'a2')).toEqual([{ t: 'joined', slot: 1 }]);
    core.close('a2', 70_000);
    phone(core, code, 'c', 'pidC', 70_000 + SLOT_HOLD_MS);
    const back = phone(core, code, 'a3', 'pidA', 71_000 + SLOT_HOLD_MS);
    expect(sends(back, 'a3')).toEqual([{ t: 'joined', slot: 3 }]);
    expect(sends(core.receive('c', json(SWING), 200_000), 'h')[0]).toMatchObject({ slot: 1 });
  });

  it('tells the replaced socket rejoined when the same pid joins again, and that socket loses its place', () => {
    const core = make();
    const { code } = host(core);
    phone(core, code, 'a', 'pidA');
    const out = phone(core, code, 'a2', 'pidA', 10);
    expect(sends(out, 'a')).toEqual([{ t: 'error', reason: 'rejoined' }]);
    expect(sends(out, 'a2')).toEqual([{ t: 'joined', slot: 1 }]);
    expect(core.receive('a', json(SWING), 20)).toEqual([]);
    // The old socket gets the handshake clock again and is closed if it lingers.
    expect(closes(core.tick(10 + 10_000)).map((c) => c.peer)).toEqual(['a']);
  });

  it('rejects a second host or a second join on the same socket', () => {
    const core = make();
    const { code } = host(core);
    expect(sends(core.receive('h', json({ t: 'host' }), 1))).toEqual([{ t: 'error', reason: 'already-connected' }]);
    expect(sends(core.receive('h', json({ t: 'join', room: code, name: 'X', pid: 'x' }), 1))).toEqual([{ t: 'error', reason: 'already-connected' }]);
    phone(core, code, 'a', 'pidA');
    expect(sends(core.receive('a', json({ t: 'join', room: code, name: 'A', pid: 'pidA' }), 2), 'a')).toEqual([{ t: 'error', reason: 'already-connected' }]);
    expect(sends(core.receive('a', json({ t: 'host' }), 2), 'a')).toEqual([{ t: 'error', reason: 'already-connected' }]);
  });

  it('keeps the v1 endpoint: create by message, join any room by message, close at once when the host leaves', () => {
    const core = make();
    core.open('h', LEGACY, 0);
    const code = String(sends(core.receive('h', json({ t: 'host' }), 0))[0].code);
    core.open('a', LEGACY, 0);
    expect(sends(core.receive('a', json({ t: 'join', room: code.toLowerCase(), name: 'Ann', pid: 'pa' }), 0), 'a')).toEqual([{ t: 'joined', slot: 1 }]);
    const out = core.close('h', 5);
    expect(sends(out, 'a')).toEqual([{ t: 'host-gone' }]);
    expect(closes(out)).toEqual([{ kind: 'close', peer: 'a', code: CLOSE_CODES.roomClosed, reason: 'host-gone' }]);
    expect(core.roomCount).toBe(0);
  });

  it('only lets each endpoint do its own job', () => {
    const core = make();
    const { code } = host(core);
    core.open('x', CREATE, 0);
    expect(sends(core.receive('x', json({ t: 'join', room: code, name: 'X', pid: 'x' }), 0), 'x')).toEqual([{ t: 'error', reason: 'wrong-endpoint' }]);
    core.open('y', room(code), 0);
    expect(sends(core.receive('y', json({ t: 'host' }), 0), 'y')).toEqual([{ t: 'error', reason: 'wrong-endpoint' }]);
    // A socket opened for one room cannot join another.
    const other = host(core, 'h2');
    expect(sends(core.receive('y', json({ t: 'join', room: other.code, name: 'Y', pid: 'y' }), 0), 'y')).toEqual([{ t: 'error', reason: 'no-room' }]);
  });

  it('refuses a socket for a missing room or a malformed code at once', () => {
    const core = make();
    for (const code of ['ZZZZ', 'abc1', '', 'ZZZZZ']) {
      expect(core.open(`p-${code}`, room(code), 0)).toEqual([
        { kind: 'send', peer: `p-${code}`, message: { t: 'error', reason: 'no-room' } },
        { kind: 'close', peer: `p-${code}`, code: CLOSE_CODES.policy, reason: 'no-room' },
      ]);
    }
    expect(core.peerCount).toBe(0);
  });

  it('reserves the code of a /ws/host socket until it sends host, and frees it if it leaves', () => {
    const core = make({ fixedCode: 'ABCD', maxRooms: 1 });
    core.open('h', CREATE, 0);
    expect(core.canCreate()).toBe(false);
    expect(core.hasRoom('ABCD')).toBe(false);
    expect(sends(core.open('p', room('ABCD'), 0))[0]).toEqual({ t: 'error', reason: 'no-room' });
    core.close('h', 1);
    expect(core.canCreate()).toBe(true);
    core.open('h2', CREATE, 2);
    expect(sends(core.receive('h2', json({ t: 'host' }), 2))[0]).toMatchObject({ t: 'room', code: 'ABCD' });
    expect(core.open('h3', CREATE, 3)).toEqual([
      { kind: 'send', peer: 'h3', message: { t: 'error', reason: 'busy' } },
      { kind: 'close', peer: 'h3', code: CLOSE_CODES.policy, reason: 'busy' },
    ]);
  });

  it('caps the rooms one address may host at once', () => {
    const core = make({ maxRoomsPerAddress: 2 });
    host(core, 'h1');
    host(core, 'h2');
    expect(sends(core.open('h3', CREATE, 0, 'host-addr'))).toEqual([{ t: 'error', reason: 'busy' }]);
    expect(sends(core.open('other', CREATE, 0, 'other-addr'))).toEqual([]);
    core.close('h1', 1);
    expect(sends(core.open('h4', CREATE, 2, 'host-addr'))).toEqual([]);
  });

  it('caps the rooms and the sockets of one instance', () => {
    const core = make({ maxRooms: 2, maxPeers: 4 });
    host(core, 'h1');
    host(core, 'h2');
    expect(sends(core.open('h3', CREATE, 0))).toEqual([{ t: 'error', reason: 'busy' }]);
    core.open('l', LEGACY, 0);
    expect(sends(core.receive('l', json({ t: 'host' }), 0))).toEqual([{ t: 'error', reason: 'busy' }]);
    core.open('l2', LEGACY, 0);
    expect(sends(core.open('l3', LEGACY, 0))).toEqual([{ t: 'error', reason: 'busy' }]);
  });
});

describe('relay core: forwarding and isolation', () => {
  it('forwards phone messages to its host with its slot, and host messages to one slot', () => {
    const core = make();
    const { code } = host(core);
    phone(core, code, 'a', 'pidA');
    phone(core, code, 'b', 'pidB');
    expect(core.receive('b', json(SWING), 1)).toEqual([{ kind: 'send', peer: 'h', message: { ...SWING, slot: 2 } }]);
    expect(core.receive('h', json({ t: 'ping', to: 1, h: 5 }), 1)).toEqual([{ kind: 'send', peer: 'a', message: { t: 'ping', to: 1, h: 5 } }]);
    for (const to of [undefined, 0, 5, 1.5, '1', null]) expect(core.receive('h', json({ t: 'ping', h: 5, to }), 1)).toEqual([]);
  });

  it('forwards every phone type with a valid shape', () => {
    const core = make();
    const { code } = host(core);
    phone(core, code, 'a', 'pidA');
    const valid: WireMessage[] = [
      SWING,
      { t: 'trace', s: [[0, 1, 2], [3, 4, 5]] },
      { t: 'raw', s: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]] },
      { t: 'status', motion: 'ok', wake: true },
      { t: 'pong', h: 1, p: 2 },
      { t: 'player-info', hand: 'right', colour: '#123456' },
      { t: 'profile', mode: 'gyro', axes: 'xyz' },
    ];
    expect(valid.map((m) => m.t).sort()).toEqual([...PHONE_TYPES].sort());
    for (const m of valid) expect(sends(core.receive('a', json(m), 1), 'h')).toEqual([{ ...m, slot: 1 }]);
  });

  it('never forwards a relay type or a host type from a phone, and overwrites slot, to and id', () => {
    const core = make();
    const { code } = host(core);
    phone(core, code, 'a', 'pidA');
    for (const t of ['player', 'room', 'joined', 'error', 'host-gone', 'host-away', 'host-back', 'ping', 'mode', 'you', 'game', 'hit', 'miss', 'nope']) {
      expect(core.receive('a', json({ t, slot: 3, state: 'out', code: 'ZZZZ', id: 'x', to: 2 }), 1)).toEqual([]);
    }
    const out = sends(core.receive('a', json({ ...SWING, slot: 4, to: 3, id: 'forged' }), 1), 'h');
    expect(out).toEqual([{ ...SWING, slot: 1 }]);
  });

  it('drops relay types from the host', () => {
    const core = make();
    const { code } = host(core);
    phone(core, code, 'a', 'pidA');
    for (const t of ['room', 'joined', 'error', 'player', 'host-gone', 'host-away', 'host-back']) {
      expect(core.receive('h', json({ t, to: 1 }), 1)).toEqual([]);
    }
  });

  it('keeps rooms apart: no message crosses from one room to another', () => {
    const core = make();
    const a = host(core, 'hA');
    const b = host(core, 'hB');
    phone(core, a.code, 'a1', 'same-pid');
    phone(core, b.code, 'b1', 'same-pid');
    expect(core.receive('a1', json(SWING), 1).map((x) => x.peer)).toEqual(['hA']);
    expect(core.receive('b1', json(SWING), 1).map((x) => x.peer)).toEqual(['hB']);
    expect(core.receive('hA', json({ t: 'ping', to: 1, h: 1 }), 1).map((x) => x.peer)).toEqual(['a1']);
    expect(core.receive('hB', json({ t: 'ping', to: 1, h: 1 }), 1).map((x) => x.peer)).toEqual(['b1']);
    // Leaving one room tells only its own host.
    expect(core.close('a1', 2).map((x) => x.peer)).toEqual(['hA']);
    expect(core.close('hB', 3).map((x) => x.peer)).toEqual(['b1']);
  });
});

describe('relay core: limits and malformed input', () => {
  it('measures frames in UTF-8 bytes', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('\u00e9')).toBe(2);
    expect(utf8Length('\u20ac')).toBe(3);
    expect(utf8Length('\ud83c\udfbe')).toBe(4);
    expect(utf8Length('x'.repeat(100), 10)).toBeGreaterThan(10);
  });

  it('forwards each phone type up to its cap and rejects it one byte over', () => {
    const base: Record<string, WireMessage> = {
      swing: SWING, trace: { t: 'trace' }, raw: { t: 'raw', s: [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]] },
      status: { t: 'status', motion: 'ok', wake: true }, pong: { t: 'pong', h: 1, p: 2 },
      'player-info': { t: 'player-info', hand: 'r', colour: 'c' }, profile: { t: 'profile' },
    };
    for (const [t, cap] of Object.entries(PHONE_MESSAGE_BYTES)) {
      const core = make();
      const { code } = host(core);
      phone(core, code, 'a', 'pidA');
      const at = padTo(base[t], cap);
      expect(utf8Length(at)).toBe(cap);
      expect(sends(core.receive('a', at, 1), 'h')).toHaveLength(1);
      expect(sends(core.receive('a', padTo(base[t], cap + 1), 2))).toEqual([{ t: 'error', reason: 'too-big' }]);
    }
  });

  it('caps host messages and control messages', () => {
    const core = make();
    const { code } = host(core);
    phone(core, code, 'a', 'pidA');
    expect(sends(core.receive('h', padTo({ t: 'game', to: 1 }, HOST_MESSAGE_BYTES), 1), 'a')).toHaveLength(1);
    expect(sends(core.receive('h', padTo({ t: 'game', to: 1 }, HOST_MESSAGE_BYTES + 1), 1))).toEqual([{ t: 'error', reason: 'too-big' }]);
    core.open('j', room(code), 0);
    expect(sends(core.receive('j', padTo({ t: 'join', room: code, name: 'J', pid: 'pj' }, CONTROL_MESSAGE_BYTES + 1), 1))).toEqual([{ t: 'error', reason: 'too-big' }]);
  });

  it('closes a socket that sends a frame over the hard cap, which frees its slot', () => {
    const core = make();
    const { code } = host(core);
    phone(core, code, 'a', 'pidA');
    const out = core.receive('a', padTo({ t: 'trace' }, MAX_FRAME_BYTES + 1), 1);
    expect(closes(out)).toEqual([{ kind: 'close', peer: 'a', code: CLOSE_CODES.tooBig, reason: 'too-big' }]);
    expect(sends(out, 'h')).toEqual([{ t: 'player', slot: 1, name: 'A', state: 'out', id: 'pidA' }]);
    // A megabyte is refused by length alone, without counting it.
    expect(closes(core.receive('h', 'x'.repeat(1 << 20), 2))[0]).toMatchObject({ code: CLOSE_CODES.tooBig });
  });

  it('survives malformed frames, forwards none of them, and still works afterwards', () => {
    const core = make();
    const { code } = host(core);
    phone(core, code, 'a', 'pidA');
    const deep = '['.repeat(4000) + ']'.repeat(4000);
    const bad: (string | null)[] = [
      null, '', 'not json', '[1,2]', '"text"', '42', 'null', '{"t":5}', '{"no":1}', '{"t":null}', deep,
      `{"t":"swing","tp":1e999,"power":0.5,"omega":900,"spin":0,"dir":1,"dur":100}`,
      `{"t":"profile","__proto__":{"polluted":true}}`,
      `{"t":"profile","a":{"constructor":{"prototype":{"x":1}}}}`,
      `{"t":"profile","prototype":1}`,
      json({ t: 'profile', a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }),
      json({ t: 'profile', s: 'x'.repeat(3000) }),
      json({ t: 'profile', s: 'bell\u0007' }),
      json({ t: 'swing', tp: '1', power: 0.5, omega: 900, spin: 0, dir: 1, dur: 100 }),
      json({ t: 'raw', s: [[1, 2, 3]] }),
      json({ t: 'raw', s: Array.from({ length: 9 }, () => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) }),
      json({ t: 'pong', h: 'x', p: 1 }),
      json({ t: 'status', motion: 'maybe', wake: true }),
      json({ t: 'player-info', hand: 5, colour: 'c' }),
    ];
    for (const frame of bad) {
      const out = core.receive('a', frame, 1);
      expect(sends(out, 'h')).toEqual([]);
      expect(closes(out)).toEqual([]);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(sends(core.receive('a', json(SWING), 1), 'h')).toEqual([{ ...SWING, slot: 1 }]);
  });

  it('checks values structurally', () => {
    expect(isSafeValue({ t: 'x', a: [1, 'b', null, true, { c: 2 }] })).toBe(true);
    expect(isSafeValue(JSON.parse('{"__proto__":1}'))).toBe(false);
    expect(isSafeValue({ s: 'line\nbreak' })).toBe(false);
    expect(isSafeValue({ s: 'line\nbreak' }, true)).toBe(true);
    expect(isSafeValue({ s: 'nul\u0000' }, true)).toBe(false);
    expect(isSafeValue({ n: Infinity })).toBe(false);
    expect(isSafeValue({ n: NaN })).toBe(false);
  });

  it('rejects names with control, bidi or zero-width characters and bad pids', () => {
    const core = make();
    const { code } = host(core);
    // Control characters fail the structural check; bidi and zero-width ones fail the name check.
    const invalid = (frame: object) => sends(core.receive('n', json(frame), 0), 'n')[0];
    const cases: [unknown, unknown, string][] = [
      ['', 'p', 'invalid-join'], ['   ', 'p', 'invalid-join'], ['x'.repeat(41), 'p', 'invalid-join'],
      ['A\u202eB', 'p', 'invalid-join'], ['A\u200bB', 'p', 'invalid-join'], ['A\u2066B', 'p', 'invalid-join'],
      [5, 'p', 'invalid-join'], ['A\u0085B', 'p', 'invalid-message'], ['A\u0007B', 'p', 'invalid-message'],
      ['Ok', '', 'invalid-join'], ['Ok', 'has space', 'invalid-join'], ['Ok', 'x'.repeat(129), 'invalid-join'],
      ['Ok', 7, 'invalid-join'], ['Ok', null, 'invalid-join'], ['Ok', 'tab\t', 'invalid-message'],
    ];
    for (const [name, pid, reason] of cases) {
      core.open('n', room(code), 0);
      expect(invalid({ t: 'join', room: code, name, pid }), JSON.stringify(name) + JSON.stringify(pid)).toEqual({ t: 'error', reason });
      core.close('n', 0);
    }
    core.open('ok', room(code), 0);
    expect(sends(core.receive('ok', json({ t: 'join', room: code, name: '  Ana  ', pid: 'p-ok' }), 0), 'h'))
      .toEqual([{ t: 'player', slot: 1, name: 'Ana', state: 'in', id: 'p-ok' }]);
  });

  it('closes a socket after the allowed number of failed joins', () => {
    const core = make();
    host(core);
    core.open('x', LEGACY, 0, 'x-addr');
    for (let i = 1; i < MAX_FAILED_JOINS; i++) {
      expect(core.receive('x', json({ t: 'join', room: 'QQQQ', name: 'X', pid: 'x' }), i)).toEqual([
        { kind: 'send', peer: 'x', message: { t: 'error', reason: 'no-room' } },
      ]);
    }
    const last = core.receive('x', json({ t: 'join', room: 'QQQQ', name: 'X', pid: 'x' }), 9);
    expect(sends(last)).toEqual([{ t: 'error', reason: 'no-room' }, { t: 'error', reason: 'too-many-attempts' }]);
    expect(closes(last)).toEqual([{ kind: 'close', peer: 'x', code: CLOSE_CODES.policy, reason: 'too-many-attempts' }]);
  });

  it('limits failed attempts per address across sockets, and forgives them over time', () => {
    const core = make({ addressFailures: { limit: 3, decayPerS: 1 } });
    for (let i = 0; i < 3; i++) expect(sends(core.open(`s${i}`, room('QQQQ'), 0, 'bad'))).toEqual([{ t: 'error', reason: 'no-room' }]);
    expect(sends(core.open('s3', room('QQQQ'), 0, 'bad'))).toEqual([{ t: 'error', reason: 'too-many-attempts' }]);
    expect(sends(core.open('s4', LEGACY, 0, 'good'))).toEqual([]);
    expect(sends(core.open('s5', LEGACY, 1500, 'bad'))).toEqual([]);
    const limiter = new AddressLimiter(2, 1, 4);
    for (let i = 0; i < 20; i++) limiter.fail(`a${i}`, 0);
    limiter.fail('x', 0);
    limiter.fail('x', 0);
    expect(limiter.blocked('x', 0)).toBe(true);
  });
});

describe('relay core: rate limits', () => {
  // Real traffic (docs/v2/PROTOCOL.md): a lab phone streams raw batches of 4 samples at about 15 per
  // second, pongs every 2 s, and sends a swing, an 8 kB trace and a profile per swing. Here it swings
  // every 0.7 s for a minute, with a 3 s Wi-Fi stall whose backlog arrives at once.
  it('never drops a message from a phone in hard normal play, stall included', () => {
    const core = make();
    const { code } = host(core);
    phone(core, code, 'a', 'pidA');
    const sample = [123456.78901234, -9.806650161743164, 0.123456789012, 3.14159265358979, -0.98765432109876,
      9.80665016174316, 0.00123456789012, 812.345678901234, -456.789012345678, 23.4567890123456];
    const frames: { at: number; frame: string }[] = [];
    for (let t = 0; t < 60_000; t += 1000 / 15) frames.push({ at: t, frame: json({ t: 'raw', s: [sample, sample, sample, sample] }) });
    for (let t = 0; t < 60_000; t += 2000) frames.push({ at: t, frame: json({ t: 'pong', h: t, p: t + 12345.678 }) });
    for (let t = 0; t < 60_000; t += 10_000) frames.push({ at: t, frame: json({ t: 'status', motion: 'ok', wake: true }) }, { at: t, frame: '{"t":"hb"}' });
    for (let t = 0; t < 60_000; t += 700) {
      frames.push({ at: t, frame: json({ ...SWING, tp: t }) });
      frames.push({ at: t + 5, frame: padTo({ t: 'trace', tp: t }, 8 * 1024) });
      frames.push({ at: t + 6, frame: json({ t: 'profile', mode: 'gyro', axes: 'x,y,z', axesLearned: true, axisMoves: 12, racket: 'y', racketSwings: 30, spinOffset: 0.0123, gyroCap: 2000, spinCalibrated: true }) });
    }
    // The stall: everything sent between 30 s and 33 s arrives at 33 s.
    const arrive = (at: number) => (at >= 30_000 && at < 33_000 ? 33_000 : at);
    frames.sort((x, y) => arrive(x.at) - arrive(y.at));
    let forwarded = 0;
    let other = 0;
    for (const { at, frame } of frames) {
      const out = core.receive('a', frame, arrive(at));
      forwarded += sends(out, 'h').length;
      other += out.filter((x) => x.peer !== 'h' && !(x.kind === 'send' && x.message.t === 'hb')).length;
    }
    expect(other).toBe(0);
    expect(forwarded).toBe(frames.filter((f) => f.frame !== '{"t":"hb"}').length);
  });

  it('never drops a message from a host running four phones', () => {
    const core = make();
    const { code } = host(core);
    for (let i = 1; i <= 4; i++) phone(core, code, `p${i}`, `pid${i}`);
    const frames: { at: number; frame: string }[] = [];
    // Match start: mode, you and game to every phone at once.
    for (let to = 1; to <= 4; to++) {
      frames.push({ at: 0, frame: json({ t: 'mode', to, mode: 'play' }) });
      frames.push({ at: 0, frame: json({ t: 'you', to, player: 1, color: '#B4471A', team: 'Clay Court' }) });
      frames.push({ at: 0, frame: json({ t: 'game', to, state: 'serve', score: '0-0, games 0-0', message: 'Your serve' }) });
    }
    for (let t = 0; t < 60_000; t += 2000) for (let to = 1; to <= 4; to++) frames.push({ at: t, frame: json({ t: 'ping', to, h: t + 0.123456789 }) });
    for (let t = 0; t < 60_000; t += 1000) {
      for (let to = 1; to <= 4; to++) frames.push({ at: t, frame: json({ t: 'game', to, state: 'rally', score: '30-15, games 1-0', message: null }) });
      frames.push({ at: t + 10, frame: json({ t: 'hit', to: 1 + (t / 1000) % 4, quality: 0.83, u: 0.12, v: -0.4, frame: false }) });
      frames.push({ at: t + 20, frame: json({ t: 'miss', to: 1 + (t / 1000 + 1) % 4 }) });
    }
    const arrive = (at: number) => (at >= 20_000 && at < 22_000 ? 22_000 : at);
    frames.sort((x, y) => arrive(x.at) - arrive(y.at));
    let delivered = 0;
    for (const { at, frame } of frames) delivered += sends(core.receive('h', frame, arrive(at))).filter((m) => m.t !== 'error').length;
    expect(delivered).toBe(frames.length);
  });

  it('drops a flood beyond the burst and closes a socket that keeps flooding', () => {
    const core = make();
    const { code } = host(core);
    phone(core, code, 'a', 'pidA');
    const pong = json({ t: 'pong', h: 1, p: 2 });
    // One burst of 100 at once: the burst passes, the rest are dropped, the socket stays.
    let passed = 0;
    for (let i = 0; i < 100; i++) passed += sends(core.receive('a', pong, 0), 'h').length;
    // The join took one token of the burst.
    expect(passed).toBe(RATE_LIMITS.phoneMessages.burst - 1);
    expect(closes(core.receive('a', pong, 5000))).toEqual([]);
    // Then twice the sustained rate: closed within a few seconds.
    let closedAt = -1;
    for (let t = 6000; t < 16_000 && closedAt < 0; t += 1000 / 80) {
      if (closes(core.receive('a', pong, t)).length) closedAt = t;
    }
    expect(closedAt).toBeGreaterThan(6000);
    expect(closedAt).toBeLessThan(10_000);
  });
});

describe('relay core: host hold and resume', () => {
  function heldRoom() {
    const core = make({ idleMs: 10 * HOST_HOLD_MS });
    const { code, key } = host(core);
    phone(core, code, 'a', 'pidA');
    phone(core, code, 'b', 'pidB');
    core.close('b', 50);
    const out = core.close('h', 100);
    return { core, code, key, out };
  }

  it('keeps the room when the host drops and tells the phones host-away', () => {
    const { core, code, out } = heldRoom();
    expect(out).toEqual([{ kind: 'send', peer: 'a', message: { t: 'host-away' } }]);
    expect(core.hasRoom(code)).toBe(true);
    expect(core.receive('a', json(SWING), 200)).toEqual([]);
    // Phones may still join while the host is away.
    expect(sends(phone(core, code, 'c', 'pidC', 300), 'c')).toEqual([{ t: 'joined', slot: 3 }]);
  });

  it('resumes with the right key: new key, every slot re-sent, phones told host-back', () => {
    const { core, code, key } = heldRoom();
    core.open('h2', room(code), 1000);
    const out = core.receive('h2', json({ t: 'host', resume: { code: code.toLowerCase(), key } }), 1000);
    const toHost = sends(out, 'h2');
    expect(toHost[0]).toMatchObject({ t: 'room', code, resumed: true });
    expect(toHost[0].key).toMatch(/^[0-9a-f]{32}$/);
    expect(toHost[0].key).not.toBe(key);
    expect(toHost.slice(1)).toEqual([
      { t: 'player', slot: 1, name: 'A', state: 'in', id: 'pidA' },
      { t: 'player', slot: 2, name: 'B', state: 'out', id: 'pidB' },
    ]);
    expect(sends(out, 'a')).toEqual([{ t: 'host-back' }]);
    expect(sends(core.receive('a', json(SWING), 1100), 'h2')).toEqual([{ ...SWING, slot: 1 }]);
    // The old key is spent.
    core.open('h3', room(code), 1200);
    expect(sends(core.receive('h3', json({ t: 'host', resume: { code, key } }), 1200), 'h3')).toEqual([{ t: 'error', reason: 'bad-key' }]);
  });

  it('never resumes with a wrong key, and counts it as a failed attempt', () => {
    const { core, code, key } = heldRoom();
    core.open('x', room(code), 1000, 'x-addr');
    const wrong = [key.slice(0, -1) + (key.endsWith('0') ? '1' : '0'), '', key + '0', key.toUpperCase(), 'x'];
    let last: Action[] = [];
    for (const guess of wrong) last = core.receive('x', json({ t: 'host', resume: { code, key: guess } }), 1000);
    expect(sends(last)).toContainEqual({ t: 'error', reason: 'too-many-attempts' });
    expect(closes(last)[0]).toMatchObject({ code: CLOSE_CODES.policy });
    expect(core.receive('a', json(SWING), 1100)).toEqual([]);
    for (const resume of [null, 'x', { code }, { key }, [code, key]]) {
      core.open('y', room(code), 1000);
      expect(sends(core.receive('y', json({ t: 'host', resume }), 1000))).toEqual([{ t: 'error', reason: 'invalid-message' }]);
      core.close('y', 1000);
    }
  });

  it('closes the room after the hold: phones get host-gone and resume finds no room', () => {
    const { core, code, key } = heldRoom();
    expect(core.nextDeadline()).toBeLessThanOrEqual(100 + HOST_HOLD_MS);
    expect(core.tick(100 + HOST_HOLD_MS - 1).filter((x) => x.peer === 'a')).toEqual([]);
    const out = core.tick(100 + HOST_HOLD_MS);
    expect(out).toEqual([
      { kind: 'send', peer: 'a', message: { t: 'host-gone' } },
      { kind: 'close', peer: 'a', code: CLOSE_CODES.roomClosed, reason: 'host-gone' },
    ]);
    expect(core.hasRoom(code)).toBe(false);
    expect(sends(core.open('h2', room(code), 100 + HOST_HOLD_MS + 1))).toEqual([{ t: 'error', reason: 'no-room' }]);
    void key;
  });

  it('lets the key take over from a host socket that is still open', () => {
    const core = make();
    const { code, key } = host(core);
    phone(core, code, 'a', 'pidA');
    core.open('h2', room(code), 10);
    const out = core.receive('h2', json({ t: 'host', resume: { code, key } }), 10);
    expect(sends(out, 'h')).toEqual([{ t: 'error', reason: 'replaced' }]);
    expect(closes(out)).toEqual([{ kind: 'close', peer: 'h', code: CLOSE_CODES.replaced, reason: 'replaced' }]);
    expect(sends(out, 'a')).toEqual([]);
    expect(core.close('h', 20)).toEqual([]);
    expect(core.receive('a', json(SWING), 30).map((x) => x.peer)).toEqual(['h2']);
  });

  it('compares keys in constant time over the secret', () => {
    expect(safeEqual('abcd', 'abcd')).toBe(true);
    expect(safeEqual('abcd', 'abce')).toBe(false);
    expect(safeEqual('abcd', 'abc')).toBe(false);
    expect(safeEqual('abcd', 'abcdabcd')).toBe(false);
    expect(safeEqual('abcd', '')).toBe(false);
  });
});

describe('relay core: liveness and state', () => {
  it('closes a socket that never finishes its handshake, and one that goes silent', () => {
    const core = make({ handshakeMs: 1000, idleMs: 5000 });
    const { code } = host(core);
    core.open('lurker', room(code), 0);
    phone(core, code, 'a', 'pidA');
    expect(core.nextDeadline()).toBe(1000);
    expect(closes(core.tick(1000))).toEqual([{ kind: 'close', peer: 'lurker', code: CLOSE_CODES.idle, reason: 'handshake' }]);
    core.seen('h', 4000);
    const out = core.tick(5000);
    expect(closes(out)).toEqual([{ kind: 'close', peer: 'a', code: CLOSE_CODES.idle, reason: 'idle' }]);
    expect(sends(out, 'h')).toEqual([{ t: 'player', slot: 1, name: 'A', state: 'out', id: 'pidA' }]);
    expect(closes(core.tick(8999))).toEqual([]);
    expect(closes(core.tick(9000))[0]).toMatchObject({ peer: 'h', reason: 'idle' });
  });

  it('keeps the default for an option passed as undefined', () => {
    const core = make({ hostHoldMs: undefined, idleMs: undefined, addressFailures: undefined });
    const { code } = host(core);
    phone(core, code, 'a', 'pidA');
    core.close('h', 0);
    expect(core.nextDeadline()).toBe(IDLE_MS);
    core.seen('a', HOST_HOLD_MS - 1);
    expect(sends(core.tick(HOST_HOLD_MS - 1), 'a')).toEqual([]);
    expect(sends(core.tick(HOST_HOLD_MS), 'a')).toEqual([{ t: 'host-gone' }]);
  });

  it('answers hb with hb', () => {
    const core = make();
    core.open('x', LEGACY, 0);
    expect(core.receive('x', '{"t":"hb"}', 0)).toEqual([{ kind: 'send', peer: 'x', message: { t: 'hb' } }]);
  });

  it('survives a snapshot and restore (Durable Object hibernation)', () => {
    const core = make({ fixedCode: 'KMNP', maxRooms: 1 });
    const { code, key } = host(core);
    phone(core, code, 'a', 'pidA');
    const copy = JSON.parse(JSON.stringify(core.snapshot()));
    const woken = make({ fixedCode: 'KMNP', maxRooms: 1 });
    woken.restore(copy, 5000);
    expect(woken.peerIds().sort()).toEqual(['a', 'h']);
    expect(sends(woken.receive('a', json(SWING), 5001), 'h')).toEqual([{ ...SWING, slot: 1 }]);
    woken.close('h', 6000);
    woken.open('h2', room(code), 7000);
    expect(sends(woken.receive('h2', json({ t: 'host', resume: { code, key } }), 7000), 'h2')[0]).toMatchObject({ t: 'room', resumed: true });
  });

  it('maps paths to endpoints', () => {
    expect(endpointFor('/ws')).toEqual({ kind: 'legacy' });
    expect(endpointFor('/ws?x=1')).toEqual({ kind: 'legacy' });
    expect(endpointFor('/ws/host')).toEqual({ kind: 'create' });
    expect(endpointFor('/ws/room/abcd')).toEqual({ kind: 'room', code: 'ABCD' });
    expect(endpointFor('/ws/room/%E0%A4%A')).toEqual({ kind: 'room', code: '' });
    expect(endpointFor('/play/')).toBeNull();
    expect(endpointFor('/wsx')).toBeNull();
  });
});
