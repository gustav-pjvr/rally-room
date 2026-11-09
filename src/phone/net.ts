// The phone's link to the relay: first join, then automatic rejoin with the same pid while the
// relay holds the slot (SLOT_HOLD_MS), with backoff between attempts. The pid comes with each
// join because it is kept per room code (src/phone/logic.ts pidFor).
import { parseMessage, SLOT_HOLD_MS, type WireMessage } from '../shared/protocol';
import { backoffDelay } from './logic';

export type LinkState =
  | { kind: 'idle' }
  | { kind: 'joining' }
  | { kind: 'joined'; slot: number; rejoin: boolean }
  | { kind: 'reconnecting'; attempt: number; until: number }
  | { kind: 'lost'; reason: 'timeout' | 'full' | 'replaced' }
  | { kind: 'gone' };

export interface LinkEvents {
  state(state: LinkState): void;
  message(message: WireMessage): void;
  joinError(reason: string): void;
}

export class Link {
  private ws: WebSocket | undefined;
  private room = '';
  private name = '';
  private pid = '';
  private current: LinkState = { kind: 'idle' };
  private attempt = 0;
  private droppedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly url: string, private readonly on: LinkEvents) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.nudge();
    });
    window.addEventListener('online', () => this.nudge());
  }

  get state(): LinkState { return this.current; }
  get joined(): boolean { return this.current.kind === 'joined' && this.ws?.readyState === WebSocket.OPEN; }

  join(room: string, name: string, pid: string) {
    this.room = room;
    this.name = name;
    this.pid = pid;
    this.attempt = 0;
    this.set({ kind: 'joining' });
    this.open(false);
  }

  /** Start the rejoin loop again after it gave up (button on the lost screen). */
  retry() {
    if (!this.room) return;
    this.droppedAt = Date.now();
    this.attempt = 0;
    this.reconnect();
  }

  send(message: WireMessage) {
    if (this.joined) this.ws!.send(JSON.stringify(message));
  }

  /** Leave on purpose: no rejoin. */
  close() {
    this.clearTimer();
    this.detach();
    this.set({ kind: 'idle' });
  }

  private nudge() {
    // A phone that slept may hold a dead socket; a reconnect loop waiting on its timer can go now.
    if (this.current.kind === 'reconnecting') { this.clearTimer(); this.open(true); return; }
    if (this.current.kind === 'joined' && this.ws && this.ws.readyState !== WebSocket.OPEN) this.dropped();
  }

  private open(rejoin: boolean) {
    this.detach();
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch { this.failed(rejoin); return; }
    this.ws = ws;
    let welcomed = false;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', room: this.room, name: this.name, pid: this.pid }));
    ws.onmessage = (event) => {
      if (ws !== this.ws) return;
      const m = parseMessage(String(event.data));
      if (!m) return;
      if (m.t === 'joined' && typeof m.slot === 'number') {
        welcomed = true;
        this.attempt = 0;
        this.set({ kind: 'joined', slot: m.slot, rejoin });
        return;
      }
      if (m.t === 'error') {
        const reason = String(m.reason ?? 'unknown');
        if (welcomed && reason === 'rejoined') { this.detach(); this.set({ kind: 'lost', reason: 'replaced' }); return; }
        if (welcomed) return;
        this.detach();
        if (!rejoin) { this.set({ kind: 'idle' }); this.on.joinError(reason); return; }
        if (reason === 'no-room') { this.set({ kind: 'gone' }); return; }
        if (reason === 'full') { this.set({ kind: 'lost', reason: 'full' }); return; }
        this.failed(true);
        return;
      }
      if (m.t === 'host-gone') { this.detach(); this.set({ kind: 'gone' }); return; }
      this.on.message(m);
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.ws = undefined;
      if (welcomed) this.dropped();
      else this.failed(rejoin);
    };
  }

  private failed(rejoin: boolean) {
    if (!rejoin) { this.set({ kind: 'idle' }); this.on.joinError('network'); return; }
    this.reconnect();
  }

  private dropped() {
    this.detach();
    this.droppedAt = Date.now();
    this.attempt = 0;
    this.reconnect();
  }

  private reconnect() {
    const until = this.droppedAt + SLOT_HOLD_MS;
    if (Date.now() >= until) { this.set({ kind: 'lost', reason: 'timeout' }); return; }
    const delay = Math.min(backoffDelay(this.attempt), Math.max(0, until - Date.now()));
    this.set({ kind: 'reconnecting', attempt: this.attempt + 1, until });
    this.attempt++;
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = undefined; this.open(true); }, delay);
  }

  private detach() {
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch { /* already closed */ }
  }

  private clearTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private set(state: LinkState) {
    this.current = state;
    this.on.state(state);
  }
}
