import { describe, expect, it } from 'vitest';
import {
  assignPlayers, ChangeFilter, eventMessages, gameMessages, gameState, matchIdentity, MAX_NAME,
  playerOfSlot, safeColor, scoreText, shortName, suggestedHumans, youMessages, type Phone, type PhoneMessage,
} from '../../src/host/phones';
import { createMatch } from '../../src/host/game/match';
import type { MatchView } from '../../src/host/game/types';

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

  it('turns a human hit into a hit for that phone only, v = spin', () => {
    const out = eventMessages([
      { type: 'hit', player: 1, quality: 0.8, power: 0.7, spin: -0.5, u: 0.2, speedKmh: 90 },
      { type: 'hit', player: 2, quality: 1, power: 1, spin: 0, u: 0, speedKmh: 90 },
    ], a, null);
    expect(out).toEqual([{ t: 'hit', to: 3, quality: 0.8, u: 0.2, v: -0.5 }]);
  });

  it('sends miss on a whiff and on a missed point for the receiver, once each', () => {
    expect(eventMessages([{ type: 'whiff', player: 0 }], a, null)).toEqual([{ t: 'miss', to: 1 }]);
    expect(eventMessages([{ type: 'point', winner: 'far', reason: 'missed' }], a, 1)).toEqual([{ t: 'miss', to: 3 }]);
    // An unreturned serve is the receiver's miss too; a human's own ace sends nothing.
    expect(eventMessages([{ type: 'point', winner: 'far', reason: 'ace' }], a, 0)).toEqual([{ t: 'miss', to: 1 }]);
    expect(eventMessages([{ type: 'point', winner: 'near', reason: 'ace' }], a, 2)).toEqual([]);
    expect(eventMessages([{ type: 'whiff', player: 1 }, { type: 'point', winner: 'far', reason: 'missed' }], a, 1))
      .toEqual([{ t: 'miss', to: 3 }]);
  });

  it('sends no miss for points lost another way, or for keyboard and CPU players', () => {
    expect(eventMessages([{ type: 'point', winner: 'far', reason: 'winner' }], a, 0)).toEqual([]);
    expect(eventMessages([{ type: 'point', winner: 'far', reason: 'missed' }], a, null)).toEqual([]);
    expect(eventMessages([{ type: 'whiff', player: 1 }], { humans: 2, slots: [1, null] }, null)).toEqual([]);
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
