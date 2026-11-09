import { describe, expect, it } from 'vitest';
import {
  awardPoint, createScore, scoreView, serveCourt, tiebreakServer, type ScoreState,
} from '../../src/host/game/scoring';
import type { Side } from '../../src/host/game/types';

const play = (state: ScoreState, winners: string) => {
  let s = state;
  for (const c of winners) s = awardPoint(s, c === 'n' ? 'near' : 'far').state;
  return s;
};
/** Win a whole game for one side (4 straight points). */
const game = (state: ScoreState, side: Side) => play(state, (side === 'near' ? 'n' : 'f').repeat(4));

describe('scoring', () => {
  it('counts 0, 15, 30, 40 and wins the game on the fourth point', () => {
    let s = createScore('games3', 'near');
    expect(scoreView(s).points).toEqual(['0', '0']);
    s = play(s, 'n');
    expect(scoreView(s).points).toEqual(['15', '0']);
    s = play(s, 'nnf');
    expect(scoreView(s).points).toEqual(['40', '15']);
    expect(scoreView(s).callout).toBe('Game point');
    const result = awardPoint(s, 'near');
    expect(result.game).toBe('near');
    expect(result.state.games).toEqual([1, 0]);
    expect(result.state.points).toEqual([0, 0]);
  });

  it('loops through deuce and advantage until a side leads by two', () => {
    let s = play(createScore('games3', 'near'), 'nnnfff');
    expect(scoreView(s).points).toEqual(['40', '40']);
    expect(scoreView(s).callout).toBe('Deuce');
    for (let i = 0; i < 5; i++) {
      s = play(s, 'f');
      expect(scoreView(s, ['Gustav', 'CPU']).points).toEqual(['40', 'AD']);
      expect(scoreView(s, ['Gustav', 'CPU']).callout).toBe('Advantage CPU');
      s = play(s, 'n');
      expect(scoreView(s).callout).toBe('Deuce');
      expect(s.games).toEqual([0, 0]);
    }
    s = play(s, 'n');
    expect(scoreView(s).points).toEqual(['AD', '40']);
    const result = awardPoint(s, 'near');
    expect(result.game).toBe('near');
  });

  it('calls a break point for the receiver', () => {
    const s = play(createScore('games3', 'near'), 'fff');
    expect(scoreView(s).callout).toBe('Break point');
  });

  it('game1 ends after one game', () => {
    let s = play(createScore('game1', 'far'), 'nnn');
    expect(scoreView(s).callout).toBe('Match point');
    const result = awardPoint(s, 'near');
    expect(result.match).toBe('near');
    s = result.state;
    expect(s.winner).toBe('near');
    expect(s.games).toEqual([1, 0]);
    // Points after the end change nothing.
    expect(awardPoint(s, 'far').state).toBe(s);
  });

  it('games3 is first to 3 games, with no tiebreak', () => {
    let s = createScore('games3', 'near');
    for (const side of ['near', 'far', 'near', 'far'] as Side[]) s = game(s, side);
    expect(s.games).toEqual([2, 2]);
    expect(s.winner).toBeNull();
    expect(s.tiebreak).toBe(false);
    s = game(s, 'far');
    expect(s.games).toEqual([2, 3]);
    expect(s.winner).toBe('far');
  });

  it('set1 ends at 6-4 and 7-5 but not at 6-5', () => {
    let s = createScore('set1', 'near');
    for (let i = 0; i < 4; i++) s = game(game(s, 'near'), 'far');
    s = game(game(s, 'near'), 'near');
    expect(s.games).toEqual([6, 4]);
    expect(s.winner).toBe('near');
    expect(s.sets).toEqual([6, 4]);

    s = createScore('set1', 'near');
    for (let i = 0; i < 5; i++) s = game(game(s, 'near'), 'far');
    s = game(s, 'far');
    expect(s.games).toEqual([5, 6]);
    expect(s.winner).toBeNull();
    s = game(s, 'far');
    expect(s.games).toEqual([5, 7]);
    expect(s.winner).toBe('far');
  });

  it('plays a tiebreak to 7, won by 2, at 6-6', () => {
    let s = createScore('set1', 'near');
    for (let i = 0; i < 6; i++) s = game(game(s, 'near'), 'far');
    expect(s.games).toEqual([6, 6]);
    expect(s.tiebreak).toBe(true);
    expect(scoreView(s).points).toEqual(['0', '0']);
    expect(scoreView(s).callout).toBe('Tiebreak');
    s = play(s, 'nfnfnfnfnfnf');
    expect(scoreView(s).points).toEqual(['6', '6']);
    expect(s.winner).toBeNull();
    s = play(s, 'n');
    expect(scoreView(s).callout).toBe('Match point');
    s = play(s, 'f');
    s = play(s, 'f');
    expect(scoreView(s).points).toEqual(['7', '8']);
    expect(s.winner).toBeNull();
    const result = awardPoint(s, 'far');
    expect(result.match).toBe('far');
    expect(result.state.games).toEqual([6, 7]);
    expect(result.state.sets).toEqual([6, 7]);
  });

  it('a 7-0 tiebreak needs no two-point margin beyond 7', () => {
    let s = createScore('set1', 'far');
    for (let i = 0; i < 6; i++) s = game(game(s, 'near'), 'far');
    s = play(s, 'nnnnnn');
    expect(s.winner).toBeNull();
    expect(awardPoint(s, 'near').match).toBe('near');
  });

  it('alternates the server each game and the serve court each point', () => {
    let s = createScore('set1', 'far');
    expect(s.server).toBe('far');
    expect(serveCourt(s)).toBe('deuce');
    s = play(s, 'n');
    expect(serveCourt(s)).toBe('ad');
    s = play(s, 'n');
    expect(serveCourt(s)).toBe('deuce');
    s = play(s, 'nn');
    expect(s.server).toBe('near');
    s = game(s, 'far');
    expect(s.server).toBe('far');
    s = game(s, 'far');
    expect(s.server).toBe('near');
  });

  it('rotates the tiebreak serve A, BB, AA, BB', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((k) => tiebreakServer('near', k)))
      .toEqual(['near', 'far', 'far', 'near', 'near', 'far', 'far']);
    let s = createScore('set1', 'near');
    for (let i = 0; i < 6; i++) s = game(game(s, 'near'), 'far');
    // 12 games played, so the near side serves first in the tiebreak.
    expect(s.tiebreak).toBe(true);
    const servers: Side[] = [s.server];
    for (const c of 'nfnfnf') {
      s = play(s, c);
      servers.push(s.server);
    }
    expect(servers).toEqual(['near', 'far', 'far', 'near', 'near', 'far', 'far']);
    expect(serveCourt(s)).toBe('deuce');
  });
});
