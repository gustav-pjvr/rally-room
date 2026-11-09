import { describe, expect, it } from 'vitest';
import {
  asGameState, asMode, backoffDelay, contrast, facePoint, hapticPattern, isYourMove, nearFrame, parseHex,
  mergeYou, pidFor, pidKey, promptFor, readableOn, rippleStyle, screenFor, spinWord,
} from '../../src/phone/logic';

describe('phone prompts', () => {
  it('maps every game state to the prompt in DESIGN.md section 3', () => {
    expect(promptFor('serve')).toBe('Your serve: swing to toss');
    expect(promptFor('toss')).toBe('Swing to hit');
    expect(promptFor('rally')).toBe('Rally');
    expect(promptFor('wait')).toBe('Get ready');
    expect(promptFor('paused')).toBe('Paused');
    expect(promptFor('over')).toBe('Match over');
    expect(promptFor(null)).toBe('Get ready');
  });
  it('rejects unknown states and marks the player-to-act states', () => {
    expect(asGameState('rally')).toBe('rally');
    expect(asGameState('bogus')).toBeNull();
    expect(isYourMove('serve') && isYourMove('toss')).toBe(true);
    expect(isYourMove('rally')).toBe(false);
  });
});

describe('screen routing', () => {
  it('needs motion before lobby or play, and treats legacy modes as play', () => {
    expect(screenFor('play', false)).toBe('allow');
    expect(screenFor('play', true)).toBe('play');
    expect(screenFor('lab', true)).toBe('lobby');
    expect(screenFor('lobby', true)).toBe('lobby');
    expect(asMode('rally')).toBe('play');
    expect(asMode('serve')).toBe('play');
    expect(asMode('nope')).toBeNull();
  });
});

describe('feedback', () => {
  it('names spin like the lab did', () => {
    expect(spinWord(0.5)).toBe('Topspin');
    expect(spinWord(-0.5)).toBe('Slice');
    expect(spinWord(0.1)).toBe('Flat');
  });
  it('buzzes longer for cleaner hits and rattles on a mishit', () => {
    expect(hapticPattern(1)[0]).toBeGreaterThan(hapticPattern(0.6)[0]);
    expect(hapticPattern(0.1)).toHaveLength(3);
    expect(hapticPattern(Number.NaN)).toHaveLength(3);
  });
  it('makes ripples bigger and brighter with quality', () => {
    const lo = rippleStyle(0.1), hi = rippleStyle(0.95);
    expect(hi.reach).toBeGreaterThan(lo.reach);
    expect(hi.alpha).toBeGreaterThan(lo.alpha);
    expect(hi.amplitude).toBeGreaterThan(lo.amplitude);
    expect(rippleStyle(5).alpha).toBeLessThanOrEqual(1);
  });
  it('places the real contact on the face: tip at the top, top edge to the right (left for a left hand)', () => {
    expect(facePoint(-0.15, 0)).toEqual({ x: 0, y: -0.15, rim: false });
    // Tip hit: high on the screen.
    expect(facePoint(0.8, 0).y).toBeCloseTo(0.8, 9);
    // Throat hit: low on the screen.
    expect(facePoint(-0.8, 0).y).toBeCloseTo(-0.8, 9);
    // Top edge: right for a right-handed grip, left for a left-handed one.
    expect(facePoint(0, 0.7).x).toBeCloseTo(0.7, 9);
    expect(facePoint(0, 0.7, true).x).toBeCloseTo(-0.7, 9);
    // A frame hit sits on the rim, in the direction it struck.
    const rim = facePoint(-1.1, 0.2);
    expect(rim.rim).toBe(true);
    expect(Math.hypot(rim.x, rim.y)).toBeCloseTo(1, 9);
    expect(rim.y).toBeLessThan(-0.9);
    expect(facePoint(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ x: 0, y: 0, rim: false });
  });
  it('reads hits near the frame as mishits', () => {
    expect(nearFrame(0, 0)).toBe(false);
    expect(nearFrame(0.9, 0)).toBe(true);
    expect(nearFrame(0.6, 0.6)).toBe(true);
  });
});

describe('reconnect backoff', () => {
  it('doubles from 0.5 s and stops at 4 s', () => {
    expect([0, 1, 2, 3, 4, 10].map(backoffDelay)).toEqual([500, 1000, 2000, 4000, 4000, 4000]);
  });
});

describe('colour', () => {
  it('lightens dark team colours until strings read on the ink bed', () => {
    for (const team of ['#0F4C5C', '#1B1B1E', '#B4471A', '#5A4488', '#2a8c8c', '#e8743b']) {
      const strings = parseHex(readableOn(team, '#1B1B1E', 3.2))!;
      expect(contrast(strings, parseHex('#1B1B1E')!)).toBeGreaterThanOrEqual(3.2);
    }
  });
});

describe('you message', () => {
  const before = { player: 2, color: '#0f4c5c', team: 'Ana & Ben' };

  it('clears player and team when the key is present and null (a watcher)', () => {
    expect(mergeYou(before, { t: 'you', player: null, color: '#e8743b', team: null }))
      .toEqual({ player: undefined, color: '#e8743b', team: undefined });
  });

  it('keeps the old value when a key is absent or invalid', () => {
    expect(mergeYou(before, { t: 'you' })).toEqual(before);
    expect(mergeYou(before, { t: 'you', player: 'x', color: 'red', team: 5 })).toEqual(before);
  });

  it('takes new values and cuts the team name to 24 characters', () => {
    expect(mergeYou({}, { t: 'you', player: 1, color: '#abc', team: 'A'.repeat(30) }))
      .toEqual({ player: 1, color: '#abc', team: 'A'.repeat(24) });
  });
});

describe('phone id per room', () => {
  it('keys the id by room code, so a re-scan or new tab of the same room is the same player', () => {
    expect(pidKey('abcd')).toBe('rally-room-pid-ABCD');
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    let n = 0;
    const make = () => `id-${++n}`;
    const first = pidFor('ABCD', storage, make);
    expect(pidFor('ABCD', storage, make)).toBe(first);
    expect(pidFor('WXYZ', storage, make)).not.toBe(first);
  });

  it('still works when storage throws (private mode)', () => {
    const broken = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); } };
    expect(pidFor('ABCD', broken, () => 'fresh')).toBe('fresh');
  });
});
