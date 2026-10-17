import { describe, expect, it } from 'vitest';
import { Game } from '../../models/game';
import { gameKeys } from '../../core/data/position-index.service';
import { buildCards } from './cards';

function game(
  id: string,
  white: string,
  black: string,
  moves: string,
  clocks: number[] | null = null,
): Game {
  return {
    id,
    rated: true,
    variant: 'standard',
    speed: 'blitz',
    perf: 'blitz',
    createdAt: Number(id),
    lastMoveAt: Number(id),
    status: 'resign',
    winner: 'white',
    players: [white, black],
    white: { name: white, id: white, rating: 1500, ratingDiff: 0 },
    black: { name: black, id: black, rating: 1500, ratingDiff: 0 },
    moves,
    opening: null,
    clock: { initial: 180, increment: 0 },
    source: null,
    clocks,
  };
}

const games = [
  game('1', 'me', 'a', 'e4 e5 Nf3 Nc6 Bb5', [18000, 18000, 17000, 17500, 16800]),
  game('2', 'me', 'b', 'e4 e5 Nf3 Nc6 Bc4', [18000, 18000, 17800, 17500, 17600]),
  game('3', 'me', 'c', 'e4 c5 Nf3', [18000, 18000, 17900]),
  game('4', 'd', 'me', 'd4 d5 c4 e6'),
];
const keysFor = (id: string) => {
  const g = games.find((x) => x.id === id);
  return g ? gameKeys(g) : undefined;
};

describe('buildCards', () => {
  it('builds a card for positions the user reached often with a habitual move', () => {
    const cards = buildCards(games, 'me', keysFor, {
      minGames: 3,
      minShare: 0.5,
      colors: ['white', 'black'],
    });
    const sans = cards.map((c) => [c.expected, c.games, c.color]);
    // Start position as White: e4 in 3 games; after 1.e4 e5 White played Nf3 twice (< 3 games).
    expect(sans).toEqual([['e4', 3, 'white']]);
    expect(cards[0].avgTimeSec).toBeNull();
  });

  it('orders slow moves first and respects colour and share thresholds', () => {
    const cards = buildCards(games, 'me', keysFor, {
      minGames: 2,
      minShare: 0.5,
      colors: ['white'],
    });
    const byKey = new Map(cards.map((c) => [c.expected + ':' + c.games, c]));
    // 2.Nf3 after 1.e4 e5: 10 s and 2 s → avg 6 s; the third move took 2 s and 2 s.
    expect(cards[0].expected).toBe('Nf3');
    expect(cards[0].avgTimeSec).toBe(6);
    expect(cards[1].avgTimeSec).toBe(2);
    // 3rd move after Nc6 differs (Bb5 / Bc4): share 0.5 passes exactly at the threshold.
    expect(byKey.has('Bb5:2') || byKey.has('Bc4:2')).toBe(true);
    expect(cards.every((c) => c.color === 'white')).toBe(true);
    expect(cards[0].line).toEqual(['e4', 'e5']);
  });
});
