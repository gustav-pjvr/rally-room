// Motion permission, the devicemotion stream into the SwingDetector, and the screen wake lock.
import type { RawSample, Swing } from '../shared/protocol';
import { SwingDetector, type ProfileReport, type SavedProfile } from '../shared/swing';

const PROFILE_KEY = 'rally-room-profile-v1';

export type MotionResult =
  | { ok: true }
  | { ok: false; status: 'denied' | 'none'; message: string };

export interface MotionEvents {
  /** First sensor sample arrived: motion works. */
  ready(): void;
  /** Nothing arrived within 3.5 s of allowing motion. */
  silent(): void;
  raw(sample: RawSample): void;
  swing(swing: { t: 'swing' } & Swing): void;
  learned(report: ProfileReport): void;
}

function loadProfile(): SavedProfile | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
    return value?.v === 1 ? value : undefined;
  } catch { return undefined; }
}

export class Motion {
  // Learns this phone's motion conventions from normal swings and remembers them (DESIGN.md section 4a).
  readonly detector = new SwingDetector(loadProfile(), (profile) => {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch { /* private mode: learn again next time */ }
    this.on.learned(this.detector.report());
  });
  private listening = false;
  private lastSensor = 0;
  private wake: WakeLockSentinel | undefined;

  constructor(private readonly on: MotionEvents) {
    document.addEventListener('visibilitychange', () => {
      if (this.listening && document.visibilityState === 'visible') void this.keepAwake();
    });
  }

  get ready(): boolean { return this.lastSensor > 0; }
  get awake(): boolean { return !!this.wake && !this.wake.released; }

  /** Must run inside a tap: iOS only shows its permission prompt from a user gesture. */
  async allow(): Promise<MotionResult> {
    if (!window.isSecureContext) {
      return { ok: false, status: 'none', message: 'Motion needs a secure connection. Open the https:// phone link from the game screen.' };
    }
    if (typeof DeviceMotionEvent === 'undefined') {
      return { ok: false, status: 'none', message: 'This browser has no motion sensor access. Try Chrome on Android or Safari on iPhone.' };
    }
    try {
      const api = DeviceMotionEvent as typeof DeviceMotionEvent & { requestPermission?: () => Promise<string> };
      if (api.requestPermission && await api.requestPermission() !== 'granted') {
        return { ok: false, status: 'denied', message: 'Motion access was turned down. On iPhone: close this tab, open the link again and tap Allow. Or enable Motion and Orientation Access in Safari settings.' };
      }
    } catch {
      return { ok: false, status: 'denied', message: 'Motion access could not be turned on. Check the browser settings for motion sensors and try again.' };
    }
    if (!this.listening) { window.addEventListener('devicemotion', this.onMotion); this.listening = true; }
    setTimeout(() => { if (!this.ready) this.on.silent(); }, 3500);
    return { ok: true };
  }

  /** Returns true when the screen will stay on. */
  async keepAwake(): Promise<boolean> {
    try {
      if (this.awake) return true;
      this.wake = await navigator.wakeLock.request('screen');
      return true;
    } catch { return false; }
  }

  private onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity, w = e.rotationRate;
    if (!a || [a.x, a.y, a.z].some((v) => v === null || !Number.isFinite(v))) return;
    // Phones without a gyroscope send no rotation rate; the detector then falls back to the accelerometer.
    const native = w && [w.alpha, w.beta, w.gamma].every((v) => v !== null && Number.isFinite(v))
      ? [w.alpha!, w.beta!, w.gamma!] as [number, number, number] : null;
    const first = !this.lastSensor;
    this.lastSensor = performance.now();
    if (first) this.on.ready();
    const result = this.detector.sample(this.lastSensor, [a.x!, a.y!, a.z!], native);
    this.on.raw(result.raw);
    if (result.swing) this.on.swing(result.swing);
  };
}
