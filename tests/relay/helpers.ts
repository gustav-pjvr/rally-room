// Helpers for the relay tests: exact-size frames, a seeded byte source, and a WebSocket test client.
import { WebSocket } from 'ws';
import { HEARTBEAT_FRAME } from '../../src/shared/protocol';

/** JSON for `message` plus a `pad` field, exactly `bytes` long (ASCII, so bytes equal characters). */
export function padTo(message: object, bytes: number): string {
  const single = JSON.stringify({ ...message, pad: '' }).length;
  if (bytes - single >= 0 && bytes - single <= 2000) return JSON.stringify({ ...message, pad: 'x'.repeat(bytes - single) });
  const remaining = bytes - JSON.stringify({ ...message, pad: [] }).length;
  if (remaining < 2) throw new Error(`cannot pad to ${bytes}`);
  // c chunks cost 2 quotes each and c - 1 commas; each chunk holds at most 2000 characters.
  const count = Math.max(1, Math.ceil((remaining + 1) / 2003));
  let left = remaining - 3 * count + 1;
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = Math.min(2000, left);
    chunks.push('x'.repeat(n));
    left -= n;
  }
  return JSON.stringify({ ...message, pad: chunks });
}

/** A repeatable stand-in for the secure random source. */
export function seededBytes(seed: number) {
  let state = seed >>> 0;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      out[i] = state >>> 24;
    }
    return out;
  };
}

export interface Received { t: string; [key: string]: unknown }

export interface TestClient {
  ws: WebSocket;
  opened: Promise<void>;
  /** Resolves with the close code once the socket closes. */
  closed: Promise<{ code: number; reason: string }>;
  inbox: Received[];
  send(message: object | string | Buffer): void;
  /** The next message of type `t` (removed from the inbox), or a rejection after `timeoutMs`. */
  next(t: string, timeoutMs?: number): Promise<Received>;
  /** Wait `ms` and return every message of type `t` that arrived (removed from the inbox). */
  collect(t: string, ms: number): Promise<Received[]>;
  close(): void;
}

/**
 * A client like a v2 page: it sends `{"t":"hb"}` every `heartbeatMs` (0 to stay silent) and answers
 * protocol pings unless `autoPong` is false.
 */
export function testClient(url: string, options: { heartbeatMs?: number; autoPong?: boolean } = {}): TestClient {
  const ws = new WebSocket(url, { autoPong: options.autoPong ?? true });
  const inbox: Received[] = [];
  const waiters = new Set<() => void>();
  ws.on('message', (data) => {
    try { inbox.push(JSON.parse(data.toString()) as Received); } catch { inbox.push({ t: '(unparsed)' }); }
    for (const wake of [...waiters]) wake();
  });
  ws.on('error', () => { /* the closed promise reports it */ });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  const heartbeatMs = options.heartbeatMs ?? 250;
  if (heartbeatMs > 0) {
    void opened.then(() => {
      timer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(HEARTBEAT_FRAME); }, heartbeatMs);
    }, () => undefined);
  }
  void closed.then(() => clearInterval(timer));
  const take = (t: string) => {
    const i = inbox.findIndex((m) => m.t === t);
    return i >= 0 ? inbox.splice(i, 1)[0] : undefined;
  };
  return {
    ws, opened, closed, inbox,
    send(message) {
      ws.send(typeof message === 'string' || Buffer.isBuffer(message) ? message : JSON.stringify(message));
    },
    next(t, timeoutMs = 4000) {
      const found = take(t);
      if (found) return Promise.resolve(found);
      return new Promise<Received>((resolve, reject) => {
        const wake = () => {
          const m = take(t);
          if (!m) return;
          waiters.delete(wake);
          clearTimeout(timeout);
          resolve(m);
        };
        const timeout = setTimeout(() => {
          waiters.delete(wake);
          reject(new Error(`no '${t}' within ${timeoutMs} ms; inbox: ${JSON.stringify(inbox).slice(0, 400)}`));
        }, timeoutMs);
        waiters.add(wake);
      });
    },
    async collect(t, ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      const out = inbox.filter((m) => m.t === t);
      for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].t === t) inbox.splice(i, 1);
      return out;
    },
    close() {
      clearInterval(timer);
      ws.close();
    },
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
