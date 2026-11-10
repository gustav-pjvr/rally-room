// The relay conformance suite against the Node `ws` adapter, plus the v1 endpoint it still serves.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachRelay } from '../server/relay';
import { CLOSE_CODES } from '../src/shared/protocol';
import { relayConformance, SETTINGS, type RelaySettings } from './relay/conformance';
import { testClient } from './relay/helpers';

async function startNode(settings: RelaySettings, heartbeatMs = 250) {
  const server: Server = createServer((_request, response) => { response.statusCode = 404; response.end(); });
  attachRelay(server, '/ws', {
    heartbeatMs,
    hostHoldMs: settings.hostHoldMs,
    handshakeMs: settings.handshakeMs,
    idleMs: settings.idleMs,
    addressFailures: { limit: settings.addressLimit, decayPerS: 0.5 },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    base: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

relayConformance('node ws adapter', (settings) => startNode(settings));

describe('node ws adapter: the v1 endpoint /ws', () => {
  let relay: Awaited<ReturnType<typeof startNode>>;
  beforeAll(async () => { relay = await startNode(SETTINGS); });
  afterAll(() => relay.close());

  it('creates and joins by message and closes the room as soon as the host leaves', async () => {
    const host = testClient(`${relay.base}/ws`);
    await host.opened;
    host.send({ t: 'host' });
    const { code } = await host.next('room');
    const phone = testClient(`${relay.base}/ws`);
    await phone.opened;
    phone.send({ t: 'join', room: String(code).toLowerCase(), name: 'Gus', pid: 'p1' });
    expect(await phone.next('joined')).toEqual({ t: 'joined', slot: 1 });
    expect(await host.next('player')).toEqual({ t: 'player', slot: 1, name: 'Gus', state: 'in', id: 'p1' });
    phone.send({ t: 'pong', h: 1, p: 2 });
    expect(await host.next('pong')).toEqual({ t: 'pong', h: 1, p: 2, slot: 1 });
    phone.send({ nope: true });
    expect(await phone.next('error')).toEqual({ t: 'error', reason: 'invalid-message' });
    host.close();
    expect(await phone.next('host-gone')).toEqual({ t: 'host-gone' });
    expect((await phone.closed).code).toBe(CLOSE_CODES.roomClosed);
  });

  it('pings sockets and closes one that stops answering, which frees its slot', async () => {
    const host = testClient(`${relay.base}/ws`, { heartbeatMs: 0 });
    await host.opened;
    host.send({ t: 'host' });
    const { code } = await host.next('room');
    // A phone whose page froze: the socket is open but nothing answers pings.
    const frozen = testClient(`${relay.base}/ws`, { heartbeatMs: 0, autoPong: false });
    await frozen.opened;
    frozen.send({ t: 'join', room: code, name: 'Sil', pid: 'ps' });
    expect(await host.next('player')).toMatchObject({ slot: 1, state: 'in', id: 'ps' });
    expect(await host.next('player', SETTINGS.idleMs + 2000)).toMatchObject({ slot: 1, state: 'out', id: 'ps' });
    expect((await frozen.closed).code).toBe(CLOSE_CODES.idle);
    // The host only answers protocol pings (a v1 page) and stays connected.
    expect(host.ws.readyState).toBe(host.ws.OPEN);
    host.close();
  });
});
