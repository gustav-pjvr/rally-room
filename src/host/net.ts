import { ClockEstimator as Clock } from '../shared/clock';
import type { Message } from '../shared/protocol';

/** Screen mode a phone is told to show (DESIGN.md section 3, Phase 3 messages). */
export type PhoneMode = 'lab' | 'lobby' | 'play';

export interface HostConnectionOptions {
  /**
   * Mode sent to a phone when it joins or rejoins. The lab sends 'lab' (the
   * default); the game page sends 'lobby', or 'play' for a phone rejoining a
   * match it is playing in.
   */
  mode?: PhoneMode | ((slot: number) => PhoneMode);
  /**
   * A phone joined, rejoined ('in') or dropped ('out'). `id` is the phone's pid
   * from the relay: the same person across reloads and slots. Runs before
   * `receive` sees the message.
   */
  onPlayer?(slot: number, name: string, state: 'in' | 'out', id: string): void;
}

export interface HostConnection {
  send(m: Message): void;
  /** Clock estimate per slot, replaced on every (re)join because a reloaded phone has a new clock. */
  clocks: Map<number, Clock>;
  /** Host time of the last pong per connected slot (set to the join time on join). */
  lastPong: Map<number, number>;
  /** Restart every slot's pong age from now (after the host tab was hidden and pings stalled). */
  touch(): void;
}

export function hostConnection(
  receive: (m: Message) => void,
  state: (s: string) => void,
  options: HostConnectionOptions = {},
): HostConnection {
  const clocks = new Map<number, Clock>();
  const lastPong = new Map<number, number>();
  const active = new Set<number>();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  const send = (m: Message) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  const ping = (to: number) => send({ t: 'ping', to, h: performance.now() });
  const modeFor = (slot: number): PhoneMode => {
    const mode = options.mode ?? 'lab';
    return typeof mode === 'function' ? mode(slot) : mode;
  };
  ws.onopen = () => send({ t: 'host' });
  ws.onmessage = event => {
    const m = JSON.parse(event.data) as Message;
    const slot = Number(m.slot);
    if (m.t === 'player') {
      const inOut = m.state === 'in' ? 'in' : 'out';
      if (inOut === 'in') {
        active.add(slot);
        clocks.set(slot, new Clock());
        lastPong.set(slot, performance.now());
      } else { active.delete(slot); lastPong.delete(slot); }
      // Before the mode is chosen: the host may re-map a returning player to this slot.
      options.onPlayer?.(slot, String(m.name ?? ''), inOut, String(m.id ?? ''));
      if (inOut === 'in') {
        send({ t: 'mode', to: slot, mode: modeFor(slot) });
        // Measure the clock straight away: swings are only trusted once it has a sample.
        ping(slot);
      }
    }
    if (m.t === 'pong' && active.has(slot)) {
      const now = performance.now();
      clocks.get(slot)?.add(Number(m.h), Number(m.p), now);
      lastPong.set(slot, now);
    }
    receive(m);
  };
  const timer = setInterval(() => active.forEach(ping), 2000);
  ws.onclose = () => { clearInterval(timer); state('Connection closed. Reload to create a new room.'); };
  ws.onerror = () => state('Could not connect to the relay. Check the dev server.');
  const touch = () => { const now = performance.now(); for (const slot of active) lastPong.set(slot, now); };
  return { send, clocks, lastPong, touch };
}
