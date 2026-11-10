/**
 * Match sound, synthesised with Web Audio (no files). The AudioContext is
 * created in unlock(), which must run inside a user gesture; until then
 * play() is silent.
 */
import type { MatchEvent, MatchView } from '../../engine/types';

export interface GameAudio {
  /** Call from the first user click or key press. Safe to call again. */
  unlock(): void;
  /** Play the sounds for one frame's events. */
  play(events: MatchEvent[], view: MatchView): void;
  setMuted(muted: boolean): void;
}

export function createAudio(): GameAudio {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let muted = false;

  function unlock(): void {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.8;
      master.connect(comp).connect(ctx.destination);
      noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') void ctx.resume();
  }

  function env(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  function tone(type: OscillatorType, f0: number, f1: number, t: number, peak: number, decay: number, attack = 0.003): void {
    if (!ctx || !master) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + attack + decay);
    env(g, t, peak, attack, decay);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
  }

  function burst(filter: BiquadFilterType, freq: number, q: number, t: number, peak: number, decay: number, attack = 0.002, freqEnd?: number): void {
    if (!ctx || !master || !noise) return;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + attack + decay);
    f.Q.value = q;
    const g = ctx.createGain();
    env(g, t, peak, attack, decay);
    src.connect(f).connect(g).connect(master);
    const offset = Math.random() * 1.5;
    src.start(t, offset);
    src.stop(t + attack + decay + 0.05);
  }

  function hit(quality: number, power: number, t: number): void {
    const q = Math.max(0, Math.min(1, quality));
    const p = Math.max(0, Math.min(1, power));
    const loud = 0.35 + 0.55 * p;
    // A clean hit is a bright, higher pop; a frame hit is duller and lower.
    tone('triangle', 420 + 420 * q + 120 * p, 180 + 120 * q, t, loud, 0.07 + 0.04 * q);
    burst('bandpass', 1400 + 3600 * q, 1.2, t, loud * (0.5 + 0.4 * q), 0.035);
    if (q < 0.35) burst('lowpass', 700, 1, t, loud * 0.5, 0.06);
  }

  function applause(rally: number, t: number, big = false): void {
    if (!ctx) return;
    const size = Math.min(1, (rally + (big ? 10 : 0)) / 14);
    const claps = Math.round(10 + 60 * size);
    const dur = 0.6 + 1.9 * size;
    const peak = 0.12 + 0.22 * size;
    for (let i = 0; i < claps; i++) {
      const at = t + Math.random() * dur * (0.4 + 0.6 * Math.random());
      const fade = 1 - (at - t) / (dur * 1.1);
      burst('bandpass', 900 + Math.random() * 1800, 1.6, at, peak * Math.max(0.15, fade) * (0.5 + Math.random() * 0.5), 0.03 + Math.random() * 0.03, 0.001);
    }
    // A soft bed under the claps so a long rally reads as a crowd.
    burst('lowpass', 1600, 0.5, t, peak * 0.5, dur, 0.08);
  }

  function chime(notes: number[], t: number, gap: number): void {
    notes.forEach((f, i) => {
      tone('sine', f, f, t + i * gap, 0.22, 0.6, 0.01);
      tone('triangle', f * 2, f * 2, t + i * gap, 0.05, 0.35, 0.01);
    });
  }

  function play(events: MatchEvent[], view: MatchView): void {
    if (!ctx || !master || muted || ctx.state !== 'running' || events.length === 0) return;
    const t = ctx.currentTime + 0.005;
    for (const e of events) {
      switch (e.type) {
        case 'hit':
          hit(e.quality, e.power, t);
          break;
        case 'bounce':
          tone('sine', 170, 85, t, 0.28, 0.08);
          burst('lowpass', 900, 0.8, t, 0.12, 0.03);
          break;
        case 'net':
          tone('sine', 95, 60, t, 0.45, 0.16);
          for (let i = 0; i < 5; i++) burst('bandpass', 2600, 3, t + 0.02 + i * 0.035, 0.12 * (1 - i / 6), 0.025);
          break;
        case 'whiff':
          burst('bandpass', 500, 2.5, t, 0.22, 0.2, 0.05, 2600);
          break;
        case 'toss':
          burst('bandpass', 900, 1.5, t, 0.05, 0.12, 0.03, 1500);
          break;
        case 'fault':
          tone('square', 220, 200, t, 0.06, 0.14);
          tone('square', 175, 160, t + 0.16, 0.06, 0.2);
          break;
        case 'point':
          applause(view.rally, t);
          break;
        case 'game':
          chime([659.25, 880], t + 0.25, 0.14);
          break;
        case 'match':
          chime([523.25, 659.25, 783.99, 1046.5], t + 0.3, 0.16);
          applause(20, t + 0.2, true);
          break;
      }
    }
  }

  function setMuted(m: boolean): void {
    muted = m;
    if (ctx && master) master.gain.setTargetAtTime(m ? 0 : 0.8, ctx.currentTime, 0.02);
  }

  return { unlock, play, setMuted };
}
