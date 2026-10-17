import { describe, expect, it } from 'vitest';
import { Game } from '../../models/game';
import { gamesAtLine, nextMoveStats, prepareGames, tally } from './tree';

function game(
  id: string,
  white: string,
  black: string,
  moves: string,
  winner: 'white' | 'black' | null,
  extra: Partial<Game> = {},
): Game {
  return {
    id,
    rated: true,
    variant: 'standard',
    speed: 'blitz',
    perf: 'blitz',
    createdAt: Number(id),
    lastMoveAt: Number(id),
    status: winner ? 'mate' : 'draw',
    winner,
    players: [white, black],
    white: { name: white, id: white, rating: 1500, ratingDiff: 0 },
    black: { name: black, id: black, rating: 1600, ratingDiff: 0 },
    moves,
    opening: null,
    clock: null,
    source: null,
    ...extra,
  };
}

const games: Game[] = [
  game('1', 'me', 'a', 'e4 e5 Nf3 Nc6', 'white'),
  game('2', 'me', 'b', 'e4 e5 Nf3 Nf6', 'black'),
  game('3', 'me', 'c', 'e4 c5 Nf3', null),
  game('4', 'd', 'me', 'd4 d5 c4', 'black'),
  game('5', 'me', 'e', 'd4 Nf6', 'white', { perf: 'bullet', rated: false }),
];

describe('prepareGames', () => {
  it('keeps only games where the user had the requested colour', () => {
    const white = prepareGames(games, 'me', { color: 'white', perfs: new Set(), rated: 'all' });
    expect(white.map((g) => g.game.id)).toEqual(['1', '2', '3', '5']);
    const black = prepareGames(games, 'me', { color: 'black', perfs: new Set(), rated: 'all' });
    expect(black.map((g) => g.game.id)).toEqual(['4']);
    expect(black[0].result).toBe('win');
    expect(black[0].opponent.name).toBe('d');
  });

  it('applies perf and rated filters', () => {
    const bullet = prepareGames(games, 'me', {
      color: 'white',
      perfs: new Set(['bullet']),
      rated: 'all',
    });
    expect(bullet.map((g) => g.game.id)).toEqual(['5']);
    const rated = prepareGames(games, 'me', { color: 'white', perfs: new Set(), rated: 'rated' });
    expect(rated.map((g) => g.game.id)).toEqual(['1', '2', '3']);
    const casual = prepareGames(games, 'me', { color: 'white', perfs: new Set(), rated: 'casual' });
    expect(casual.map((g) => g.game.id)).toEqual(['5']);
  });
});

describe('tree walking', () => {
  const prepared = prepareGames(games, 'me', { color: 'white', perfs: new Set(), rated: 'all' });

  it('aggregates first moves', () => {
    const stats = nextMoveStats(gamesAtLine(prepared, []), 0);
    expect(stats.map((s) => [s.san, s.games])).toEqual([
      ['e4', 3],
      ['d4', 1],
    ]);
    expect(stats[0]).toMatchObject({
      wins: 1,
      draws: 1,
      losses: 1,
      avgOpponentRating: 1600,
      lastPlayed: 3,
    });
  });

  it('narrows along a line', () => {
    const line = ['e4', 'e5', 'Nf3'];
    const at = gamesAtLine(prepared, line);
    expect(at.map((g) => g.game.id)).toEqual(['1', '2']);
    expect(tally(at)).toEqual({ games: 2, wins: 1, draws: 0, losses: 1 });
    const next = nextMoveStats(at, line.length);
    expect(next.map((s) => s.san).sort()).toEqual(['Nc6', 'Nf6']);
  });

  it('returns nothing past the end of all games', () => {
    expect(nextMoveStats(gamesAtLine(prepared, ['d4', 'Nf6']), 2)).toEqual([]);
    expect(gamesAtLine(prepared, ['e4', 'e6'])).toEqual([]);
  });
});
