import { describe, expect, it } from 'vitest';
import { Game } from './game';
import { formatSeconds, moveTimes } from './move-times';

function game(moves: string, clocks: number[] | null, increment = 0): Game {
  return {
    id: 'g',
    rated: true,
    variant: 'standard',
    speed: 'blitz',
    perf: 'blitz',
    createdAt: 0,
    lastMoveAt: 0,
    status: 'resign',
    winner: 'white',
    players: ['a', 'b'],
    white: { name: 'a', id: 'a', rating: null, ratingDiff: null },
    black: { name: 'b', id: 'b', rating: null, ratingDiff: null },
    moves,
    opening: null,
    clock: clocks ? { initial: 180, increment } : null,
    source: null,
    clocks,
  };
}

describe('moveTimes', () => {
  it('derives thinking time from consecutive readings of the same side', () => {
    // 3+0: white 18000 → 17500 (5 s), black 18000 → 17000 (10 s)
    const times = moveTimes(game('e4 e5 Nf3 Nc6', [18000, 18000, 17500, 17000]));
    expect(times).toEqual([null, null, 5, 10]);
  });

  it('accounts for the increment', () => {
    // 3+2: white 18000 → 18100 means 1 s spent (gained 2, lost 1)
    const times = moveTimes(game('e4 e5 Nf3', [18000, 18000, 18100], 2));
    expect(times).toEqual([null, null, 1]);
  });

  it('returns nulls without clock data or past the end of the readings', () => {
    expect(moveTimes(game('e4 e5 Nf3', null))).toEqual([null, null, null]);
    expect(moveTimes(game('e4 e5 Nf3 Nc6', [18000, 18000, 17500]))).toEqual([null, null, 5, null]);
  });
});

describe('formatSeconds', () => {
  it('picks a unit by magnitude', () => {
    expect(formatSeconds(0.8)).toBe('0.8s');
    expect(formatSeconds(12.4)).toBe('12s');
    expect(formatSeconds(65)).toBe('1m05');
  });
});
