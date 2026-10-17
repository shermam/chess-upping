import { describe, expect, it } from 'vitest';
import { Game } from '../../models/game';
import {
  DEFAULT_FILTERS,
  gamesAtLine,
  nextMoveStats,
  prepareGames,
  score,
  scoreClass,
  sortStats,
  tally,
} from './tree';

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
    clock: { initial: 180, increment: 0 },
    source: null,
    clocks: null,
    ...extra,
  };
}

const games: Game[] = [
  game('1', 'me', 'a', 'e4 e5 Nf3 Nc6', 'white', { clocks: [18000, 18000, 17000, 17500] }),
  game('2', 'me', 'b', 'e4 e5 Nf3 Nf6', 'black', { clocks: [18000, 18000, 17800, 17900] }),
  game('3', 'me', 'c', 'e4 c5 Nf3', null),
  game('4', 'd', 'me', 'd4 d5 c4', 'black'),
  game('5', 'me', 'e', 'd4 Nf6', 'white', { perf: 'bullet', rated: false }),
];
const asWhite = { ...DEFAULT_FILTERS, color: 'white' as const };

describe('prepareGames', () => {
  it('keeps only games where the user had the requested colour', () => {
    const white = prepareGames(games, 'me', asWhite);
    expect(white.map((g) => g.game.id)).toEqual(['1', '2', '3', '5']);
    const black = prepareGames(games, 'me', { ...DEFAULT_FILTERS, color: 'black' });
    expect(black.map((g) => g.game.id)).toEqual(['4']);
    expect(black[0].result).toBe('win');
    expect(black[0].opponent.name).toBe('d');
  });

  it('applies perf and rated filters', () => {
    expect(
      prepareGames(games, 'me', { ...asWhite, perfs: new Set(['bullet']) }).map((g) => g.game.id),
    ).toEqual(['5']);
    expect(prepareGames(games, 'me', { ...asWhite, rated: 'rated' }).map((g) => g.game.id)).toEqual(
      ['1', '2', '3'],
    );
    expect(
      prepareGames(games, 'me', { ...asWhite, rated: 'casual' }).map((g) => g.game.id),
    ).toEqual(['5']);
  });

  it('applies result, date and opponent rating filters', () => {
    expect(prepareGames(games, 'me', { ...asWhite, result: 'loss' }).map((g) => g.game.id)).toEqual(
      ['2'],
    );
    expect(prepareGames(games, 'me', { ...asWhite, result: 'win' }).map((g) => g.game.id)).toEqual([
      '1',
      '5',
    ]);
    expect(prepareGames(games, 'me', { ...asWhite, since: 3 }).map((g) => g.game.id)).toEqual([
      '3',
      '5',
    ]);
    expect(prepareGames(games, 'me', { ...asWhite, ratingMin: 1601 })).toEqual([]);
    expect(prepareGames(games, 'me', { ...asWhite, ratingMax: 1600 }).length).toBe(4);
    expect(prepareGames(games, 'me', { ...asWhite, ratingMin: 1500, ratingMax: 1600 }).length).toBe(
      4,
    );
  });
});

describe('tree walking', () => {
  const prepared = prepareGames(games, 'me', asWhite);

  it('aggregates first moves with times', () => {
    const stats = sortStats(nextMoveStats(gamesAtLine(prepared, []), 0), 'games');
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
    // First moves carry no clock time.
    expect(stats[0].avgTimeSec).toBeNull();
  });

  it('averages the time spent on a move across games', () => {
    const at = gamesAtLine(prepared, ['e4', 'e5']);
    const nf3 = nextMoveStats(at, 2)[0];
    // game 1: 10 s, game 2: 2 s
    expect(nf3.avgTimeSec).toBe(6);
    expect(nf3.timeSamples).toBe(2);
  });

  it('narrows along a line', () => {
    const line = ['e4', 'e5', 'Nf3'];
    const at = gamesAtLine(prepared, line);
    expect(at.map((g) => g.game.id)).toEqual(['1', '2']);
    expect(tally(at)).toEqual({ games: 2, wins: 1, draws: 0, losses: 1 });
    expect(score(tally(at))).toBe(0.5);
    const next = nextMoveStats(at, line.length);
    expect(next.map((s) => s.san).sort()).toEqual(['Nc6', 'Nf6']);
  });

  it('returns nothing past the end of all games', () => {
    expect(nextMoveStats(gamesAtLine(prepared, ['d4', 'Nf6']), 2)).toEqual([]);
    expect(gamesAtLine(prepared, ['e4', 'e6'])).toEqual([]);
  });
});

describe('sortStats and scoreClass', () => {
  const a = {
    san: 'a',
    games: 10,
    wins: 8,
    draws: 0,
    losses: 2,
    avgOpponentRating: null,
    lastPlayed: 5,
    avgTimeSec: 3,
    timeSamples: 10,
  };
  const b = {
    san: 'b',
    games: 20,
    wins: 5,
    draws: 5,
    losses: 10,
    avgOpponentRating: null,
    lastPlayed: 9,
    avgTimeSec: 12,
    timeSamples: 20,
  };
  it('sorts by each key', () => {
    expect(sortStats([a, b], 'games').map((s) => s.san)).toEqual(['b', 'a']);
    expect(sortStats([a, b], 'score').map((s) => s.san)).toEqual(['a', 'b']);
    expect(sortStats([a, b], 'recent').map((s) => s.san)).toEqual(['b', 'a']);
    expect(sortStats([a, b], 'time').map((s) => s.san)).toEqual(['b', 'a']);
  });
  it('flags moves scoring clearly above or below the node', () => {
    const node = { games: 30, wins: 13, draws: 5, losses: 12 };
    expect(scoreClass(a, node)).toBe('good');
    expect(scoreClass(b, node)).toBe('poor');
    expect(scoreClass({ games: 2, wins: 0, draws: 0, losses: 2 }, node)).toBeNull();
  });
});
