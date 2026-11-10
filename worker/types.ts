// The small part of the Workers runtime the relay uses, typed here so the Worker compiles under the
// repo's one tsconfig (DOM types) without pulling in @cloudflare/workers-types, whose globals clash
// with the DOM's. Each interface is a subset of the runtime's real one.

/** A server-side WebSocket in a Durable Object, accepted through the hibernation API. */
export interface HibernatableSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface DurableState {
  storage: DurableStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  acceptWebSocket(socket: HibernatableSocket, tags?: string[]): void;
  getWebSockets(tag?: string): HibernatableSocket[];
  setWebSocketAutoResponse(pair?: unknown): void;
  getWebSocketAutoResponseTimestamp(socket: HibernatableSocket): Date | null;
}

export interface DurableStub { fetch(request: Request): Promise<Response> }
export interface DurableNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableStub;
}

export interface Env {
  ROOMS: DurableNamespace;
  /** The built site, when the Worker also serves it (wrangler `assets` binding). */
  ASSETS?: { fetch(request: Request): Promise<Response> };
  // Optional overrides, as strings (wrangler vars), used by the local tests to shorten the clocks.
  RELAY_HOST_HOLD_MS?: string;
  RELAY_HANDSHAKE_MS?: string;
  RELAY_IDLE_MS?: string;
  RELAY_SLOT_HOLD_MS?: string;
  RELAY_ADDRESS_LIMIT?: string;
}

/** Runtime globals that are not in the DOM types. */
export interface WorkersGlobals {
  WebSocketPair: new () => { 0: WebSocket & HibernatableSocket & { accept(): void }; 1: WebSocket & HibernatableSocket & { accept(): void } };
  WebSocketRequestResponsePair: new (request: string, response: string) => unknown;
}
export const workers = globalThis as unknown as WorkersGlobals;

/** A 101 response that hands the client end of a WebSocketPair back to the runtime. */
export function upgradeResponse(client: WebSocket): Response {
  return new Response(null, { status: 101, webSocket: client } as ResponseInit);
}

export function intVar(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
