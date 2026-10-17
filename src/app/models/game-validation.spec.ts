import { describe, expect, it } from 'vitest';
import { parseLichessGame } from '../core/lichess/lichess-game';
import { isValidGame, toGame } from './game-validation';

const game = parseLichessGame({
  id: 'abcd1234',
  rated: true,
  variant: 'standard',
  speed: 'blitz',
  perf: 'blitz',
  createdAt: 1,
  lastMoveAt: 2,
  status: 'mate',
  winner: 'white',
  players: { white: { user: { name: 'A', id: 'a' }, rating: 1500 }, black: { aiLevel: 2 } },
  moves: 'e4 e5',
})!;

describe('isValidGame', () => {
  it('accepts games produced by the Lichess parser', () => {
    expect(isValidGame(game)).toBe(true);
  });

  it('rejects documents missing or mistyping required fields', () => {
    const { white: _white, ...noWhite } = game;
    expect(isValidGame(noWhite)).toBe(false);
    expect(isValidGame({ ...game, winner: 'draw' })).toBe(false);
    expect(isValidGame({ ...game, players: [] })).toBe(false);
    expect(isValidGame({ ...game, players: [1] })).toBe(false);
    expect(isValidGame({ ...game, moves: '' })).toBe(false);
    expect(isValidGame({ ...game, variant: 'chess960' })).toBe(false);
    expect(isValidGame({ ...game, white: { ...game.white, id: 5 } })).toBe(false);
    expect(isValidGame(null)).toBe(false);
    expect(isValidGame('x')).toBe(false);
  });

  it('strips unknown fields when converting', () => {
    const converted = toGame({ ...game, uploadedBy: 'uid', uploadedAt: { seconds: 1 } });
    expect(converted).toEqual(game);
  });
});
