import { describe, expect, it } from 'vitest';
import {
  assignPlayers, ChangeFilter, eventMessages, gameMessages, gameState, matchIdentity, MAX_NAME,
  playerOfSlot, safeColor, scoreText, shortName, suggestedHumans, youMessages, type Phone, type PhoneMessage,
} from '../../src/host/phones';
import { createMatch } from '../../src/host/game/match';
import type { MatchEvent, MatchView } from '../../src/host/game/types';

const phone = (slot: number, seq: number, extra: Partial<Phone> = {}): Phone =>
  ({ slot, name: `P${slot}`, color: null, connected: true, seq, ...extra });

function view(over: Partial<MatchView> = {}): MatchView {
  const base = createMatch({ mode: 'doubles', humans: 2, level: 'club', window: 'normal', length: 'games3', seed: 1 }).view();
  return { ...base, ...over };
}

describe('slot to player mapping', () => {
  it('makes the first two connected phones to join players 1 and 2, whatever their slots', () => {
    const phones = [phone(3, 1), phone(1, 5), phone(2, 2)];
    expect(assignPlayers(phones, 'doubles', 2)).toEqual({ humans: 2, slots: [3, 2] });
  });

  it('singles always has one human, the first phone', () => {
    expect(assignPlayers([phone(2, 2), phone(1, 1)], 'singles', 2)).toEqual({ humans: 1, slots: [1] });
  });

  it('skips disconnected phones and leaves keyboard players as null', () => {
    const phones = [phone(1, 1, { connected: false }), phone(2, 2)];
    expect(assignPlayers(phones, 'doubles', 2)).toEqual({ humans: 2, slots: [2, null] });
    expect(assignPlayers([], 'singles', 1)).toEqual({ humans: 1, slots: [null] });
  });

  it('suggests one human per connected phone, 1 to 2', () => {
    expect(suggestedHumans([])).toBe(1);
    expect(suggestedHumans([phone(1, 1)])).toBe(1);
    expect(suggestedHumans([phone(1, 1), phone(2, 2), phone(3, 3)])).toBe(2);
    expect(suggestedHumans([phone(1, 1), phone(2, 2, { connected: false })])).toBe(1);
  });

  it('finds the player of a slot', () => {
    const a = { humans: 2 as const, slots: [4, 2] };
    expect(playerOfSlot(a, 2)).toBe(1);
    expect(playerOfSlot(a, 1)).toBe(-1);
  });
});

describe('names and colours', () => {
  it('shortens a 40 character name and keeps short ones', () => {
    const long = 'Bartholomew Alexander Fitzgerald-Smythe!';
    expect(long.length).toBe(40);
    const s = shortName(long);
    expect([...s].length).toBeLessThanOrEqual(MAX_NAME);
    expect(s.endsWith('…')).toBe(true);
    expect(shortName('  Ana ')).toBe('Ana');
  });

  it('accepts only hex colours', () => {
    expect(safeColor('#B4471A')).toBe('#b4471a');
    expect(safeColor('#abc')).toBe('#aabbcc');
    expect(safeColor('red')).toBeNull();
    expect(safeColor('#123456;background:url(x)')).toBeNull();
    expect(safeColor(5)).toBeNull();
  });

  it('builds MatchConfig names and colours with defaults for keyboard players', () => {
    const phones = new Map([[2, phone(2, 1, { name: 'Ana', color: '#0f4c5c' })]]);
    const id = matchIdentity({ humans: 2, slots: [2, null] }, phones);
    expect(id.names).toEqual(['Ana', 'Player 2']);
    expect(id.colors).toEqual(['#0f4c5c', '#2a8c8c']);
  });
});

describe('messages to phones', () => {
  const a = { humans: 2 as const, slots: [1, 3] };

  it('turns a human hit into a hit for that phone only, carrying where the ball met the face', () => {
    const out = eventMessages([
      { type: 'hit', player: 1, quality: 0.8, power: 0.7, spin: -0.5, u: 0.2, speedKmh: 90, contact: { a: 0.62, b: -0.3, frame: false } },
      { type: 'hit', player: 2, quality: 1, power: 1, spin: 0, u: 0, speedKmh: 90, contact: { a: -0.15, b: 0, frame: false } },
    ], a, null);
    // u = a (along the racket), v = b (across it): the real contact, not timing and spin.
    expect(out).toEqual([{ t: 'hit', to: 3, quality: 0.8, u: 0.62, v: -0.3, frame: false }]);
  });

  it('marks a frame hit and keeps its point on the frame, clamping wild values', () => {
    const out = eventMessages([
      { type: 'hit', player: 0, quality: 0.05, power: 0.7, spin: 0, u: 1.3, speedKmh: 30, contact: { a: -1.1, b: 0.2, frame: true } },
      { type: 'hit', player: 0, quality: 0.05, power: 0.7, spin: 0, u: 1.3, speedKmh: 30, contact: { a: 9, b: Number.NaN, frame: true } },
    ], a, null);
    expect(out).toEqual([
      { t: 'hit', to: 1, quality: 0.05, u: -1.1, v: 0.2, frame: true },
      { t: 'hit', to: 1, quality: 0.05, u: 1.25, v: 0, frame: true },
    ]);
  });

  it('sends miss for a missed point and for an ace, once, to the receiver', () => {
    expect(eventMessages([{ type: 'point', winner: 'far', reason: 'missed' }], a, 1)).toEqual([{ t: 'miss', to: 3 }]);
    // An unreturned serve is the receiver's miss too; a human's own ace sends nothing.
    expect(eventMessages([{ type: 'point', winner: 'far', reason: 'ace' }], a, 0)).toEqual([{ t: 'miss', to: 1 }]);
    expect(eventMessages([{ type: 'point', winner: 'near', reason: 'ace' }], a, 2)).toEqual([]);
    expect(eventMessages([{ type: 'whiff', player: 1 }, { type: 'point', winner: 'far', reason: 'missed' }], a, 1))
      .toEqual([{ t: 'miss', to: 3 }]);
  });

  describe('a whiff leaves the ball live, so only the outcome sends a miss', () => {
    const hit = (player: number): MatchEvent => ({
      type: 'hit', player, quality: 0.8, power: 0.5, spin: 0, u: 0, speedKmh: 80, contact: { a: 0.1, b: 0, frame: false },
    });

    it('a whiff alone sends nothing', () => {
      expect(eventMessages([{ type: 'whiff', player: 0 }], a, null, new Set())).toEqual([]);
    });

    it('whiff, then a good swing: only the hit reaches the phone, in one frame or across frames', () => {
      expect(eventMessages([{ type: 'whiff', player: 0 }, hit(0)], a, null, new Set()))
        .toEqual([{ t: 'hit', to: 1, quality: 0.8, u: 0.1, v: 0, frame: false }]);
      const state = new Set<number>();
      const out = [
        ...eventMessages([{ type: 'whiff', player: 0 }], a, 0, state),
        ...eventMessages([hit(0)], a, 0, state),
        // The next ball is lost to a CPU winner the player never swung at: no stale miss.
        ...eventMessages([{ type: 'point', winner: 'far', reason: 'winner' }], a, 0, state),
      ];
      expect(out.map((m) => m.t)).toEqual(['hit']);
    });

    it('whiff, then nothing: exactly one miss, when the point is decided', () => {
      for (const reason of ['missed', 'ace'] as const) {
        const state = new Set<number>();
        const out = [
          ...eventMessages([{ type: 'whiff', player: 0 }], a, 0, state),
          ...eventMessages([], a, 0, state),
          ...eventMessages([{ type: 'point', winner: 'far', reason }], a, 0, state),
        ];
        expect(out, reason).toEqual([{ t: 'miss', to: 1 }]);
      }
    });

    it('whiff at an unreachable ball (point reason winner): still one miss, at the point', () => {
      const state = new Set<number>();
      const out = [
        ...eventMessages([{ type: 'whiff', player: 0 }], a, 0, state),
        ...eventMessages([{ type: 'point', winner: 'far', reason: 'winner' }], a, 0, state),
      ];
      expect(out).toEqual([{ t: 'miss', to: 1 }]);
      expect(state.size).toBe(0);
    });

    it('a whiff does not leak into the next point', () => {
      const state = new Set<number>();
      eventMessages([{ type: 'whiff', player: 0 }], a, 0, state);
      eventMessages([{ type: 'point', winner: 'far', reason: 'out' }], a, 0, state);
      expect(eventMessages([{ type: 'point', winner: 'far', reason: 'winner' }], a, 0, state)).toEqual([]);
    });
  });

  describe('against the real match', () => {
    /** The phone messages a human receives while one real incoming ball is whiffed at, then optionally hit. */
    function play(thenHit: boolean) {
      const m = createMatch({ mode: 'singles', humans: 1, level: 'rookie', window: 'normal', length: 'set1', seed: 1 });
      const as = { humans: 1 as const, slots: [7] };
      const state = new Set<number>();
      const out: PhoneMessage[] = [];
      let now = 1000;
      let before: number | null = null;
      const step = (to: number) => {
        now = to;
        const events = m.update(to);
        out.push(...eventMessages(events, as, before, state));
        before = m.view().players.find((p) => p.receiving)?.id ?? null;
        return events;
      };
      step(now);
      while (!(m.expectedContact(0) !== null && m.view().phase === 'rally' && m.view().ball.bounces >= 1)) step(now + 1000 / 60);
      const tStar = m.expectedContact(0)!;
      const W = 130;
      while (now < tStar - 1.5 * W) step(now + 1000 / 60);
      // 1.5 W early with full topspin: far off the frame, a clean miss.
      m.swing({ player: 0, t: now, power: 0.9, spin: 1 });
      step(now + 1000 / 60);
      if (thenHit) {
        while (now < tStar) step(now + 1000 / 60);
        m.swing({ player: 0, t: tStar, power: 0.5, spin: 0.2 });
        step(now + 1000 / 60);
        step(now + 1000 / 60);
      }
      const until = now + 3000;
      while (now < until && m.view().phase === 'rally') step(now + 1000 / 60);
      return out;
    }

    it('whiff then a good swing: a hit and no miss', () => {
      const out = play(true).filter((x) => x.t === 'hit' || x.t === 'miss').map((x) => x.t);
      expect(out[0]).toBe('hit');
    });

    it('whiff then nothing: exactly one miss', () => {
      expect(play(false).filter((x) => x.t === 'miss')).toHaveLength(1);
    });
  });

  it('sends no miss for points lost another way, or for keyboard and CPU players', () => {
    expect(eventMessages([{ type: 'point', winner: 'far', reason: 'winner' }], a, 0)).toEqual([]);
    expect(eventMessages([{ type: 'point', winner: 'far', reason: 'missed' }], a, null)).toEqual([]);
    expect(eventMessages([{ type: 'whiff', player: 1 }, { type: 'point', winner: 'far', reason: 'winner' }], { humans: 2, slots: [1, null] }, null)).toEqual([]);
  });

  it('maps the match phase to each player\'s prompt', () => {
    expect(gameState(view({ phase: 'serve-wait', serverIndex: 0 }), 0, false)).toBe('serve');
    expect(gameState(view({ phase: 'serve-wait', serverIndex: 2 }), 0, false)).toBe('wait');
    expect(gameState(view({ phase: 'toss', serverIndex: 0 }), 0, false)).toBe('toss');
    expect(gameState(view({ phase: 'toss', serverIndex: 0 }), 1, false)).toBe('wait');
    expect(gameState(view({ phase: 'rally' }), 1, false)).toBe('rally');
    expect(gameState(view({ phase: 'point-over' }), 0, false)).toBe('wait');
    expect(gameState(view({ phase: 'rally' }), 0, true)).toBe('paused');
    expect(gameState(view({ phase: 'match-over' }), 0, true)).toBe('over');
  });

  it('writes the score from the humans\' side', () => {
    const v = view();
    expect(scoreText({ ...v, score: { ...v.score, points: ['30', '15'], games: [1, 0] } })).toBe('30-15, games 1-0');
    expect(scoreText({ ...v, score: { ...v.score, points: ['3', '2'], games: [6, 6], tiebreak: true } })).toBe('Tiebreak 3-2, games 6-6');
  });

  it('builds a game message per playing phone, and the filter passes changes only', () => {
    const v = view({ phase: 'serve-wait', serverIndex: 0, message: null });
    const msgs = gameMessages(v, { humans: 2, slots: [1, null] }, false) as Extract<PhoneMessage, { t: 'game' }>[];
    expect(msgs).toEqual([{ t: 'game', to: 1, state: 'serve', score: '0-0, games 0-0', message: null }]);
    const f = new ChangeFilter();
    expect(f.pass(msgs[0])).toBe(true);
    expect(f.pass({ ...msgs[0] })).toBe(false);
    expect(f.pass({ ...msgs[0], state: 'toss' })).toBe(true);
    f.forget(1);
    expect(f.pass({ ...msgs[0], state: 'toss' })).toBe(true);
  });

  it('tells each connected phone its player number, colour and team', () => {
    const phones = [phone(1, 1, { name: 'Ana', color: '#b4471a' }), phone(2, 2, { name: 'Ben' }), phone(3, 3, { connected: false })];
    const assign = assignPlayers(phones, 'singles', 1);
    const out = youMessages(phones, assign, ['Ana'], ['#b4471a']);
    expect(out).toEqual([
      { t: 'you', to: 1, player: 1, color: '#b4471a', team: 'Ana' },
      { t: 'you', to: 2, player: null, color: '#e8743b', team: null },
    ]);
  });
});
