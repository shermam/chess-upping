import { describe, expect, it } from 'vitest';
import { accuracy, judgeMoves, judgementFor } from './analysis';
import { PositionEval } from './position-eval';

const W = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const B = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const W2 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

function ev(
  fen: string,
  cp: number | null,
  mate: number | null = null,
  bestMove = 'e2e4',
): PositionEval {
  return {
    key: fen,
    fen,
    cp,
    mate,
    depth: 16,
    bestMove,
    pv: '',
    engine: 'x',
    nodes: 0,
    evaluatedAt: 0,
  };
}

describe('judgementFor', () => {
  it('maps drops to Lichess-style judgements', () => {
    expect(judgementFor(5)).toBeNull();
    expect(judgementFor(10)).toBe('inaccuracy');
    expect(judgementFor(20)).toBe('mistake');
    expect(judgementFor(31)).toBe('blunder');
  });
});

describe('judgeMoves', () => {
  it('measures the drop from the mover side and skips moves without evals', () => {
    const plies = [
      { fen: W, key: W, san: null },
      { fen: B, key: B, san: 'e4' },
      { fen: W2, key: W2, san: 'e5' },
    ];
    // White: +0.30 → after e4 still +0.30 (no drop). Black then plays into -3.00 for Black.
    const evals = new Map([
      [W, ev(W, 30)],
      [B, ev(B, 30)],
      [W2, ev(W2, 300)],
    ]);
    const judged = judgeMoves(plies, evals);
    expect(judged.map((m) => [m.ply, m.san, m.color])).toEqual([
      [1, 'e4', 'white'],
      [2, 'e5', 'black'],
    ]);
    expect(judged[0].drop).toBe(0);
    expect(judged[0].judgement).toBeNull();
    expect(judged[1].drop).toBeGreaterThan(20);
    expect(judged[1].judgement).toBe('mistake');
    // A missing eval drops the move from the list.
    expect(judgeMoves(plies, new Map([[W, ev(W, 0)]]))).toEqual([]);
  });

  it('treats a mate allowed as a blunder for the mover', () => {
    const plies = [
      { fen: W, key: W, san: null },
      { fen: B, key: B, san: 'f3' },
    ];
    const evals = new Map([
      [W, ev(W, 0)],
      [B, ev(B, null, -2)],
    ]);
    expect(judgeMoves(plies, evals)[0].judgement).toBe('blunder');
  });
});

describe('accuracy', () => {
  it('is 100 for no losses and lower with drops', () => {
    const perfect = [
      {
        ply: 1,
        san: 'e4',
        color: 'white' as const,
        before: 55,
        after: 55,
        drop: 0,
        judgement: null,
        bestMove: null,
      },
    ];
    expect(accuracy(perfect, 'white')).toBe(100);
    const sloppy = [{ ...perfect[0], after: 25, drop: 30 }];
    expect(accuracy(sloppy, 'white')!).toBeLessThan(30);
    expect(accuracy(perfect, 'black')).toBeNull();
  });
});
