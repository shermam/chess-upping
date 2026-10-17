import { describe, expect, it } from 'vitest';
import { parseBestMove, parseInfo, pickBetter } from './uci';

describe('parseInfo', () => {
  it('parses depth, score, nodes and pv', () => {
    const info = parseInfo(
      'info depth 16 seldepth 19 multipv 1 score cp 19 nodes 148115 nps 597237 hashfull 52 time 248 pv d2d3 f8e7 b1c3',
    );
    expect(info).toEqual({
      depth: 16,
      multipv: 1,
      cp: 19,
      mate: null,
      nodes: 148115,
      pv: ['d2d3', 'f8e7', 'b1c3'],
    });
  });

  it('parses mate scores and ignores progress lines', () => {
    expect(parseInfo('info depth 20 score mate -3 nodes 10 pv e1g1')).toMatchObject({
      mate: -3,
      cp: null,
    });
    expect(parseInfo('info depth 12 currmove e2e4 currmovenumber 1')).toBeNull();
    expect(parseInfo('info string NNUE evaluation using nn-xxx.nnue')).toBeNull();
    expect(parseInfo('bestmove e2e4')).toBeNull();
  });
});

describe('parseBestMove', () => {
  it('extracts the move or null for (none)', () => {
    expect(parseBestMove('bestmove e2e4 ponder e7e5')).toEqual({ bestMove: 'e2e4' });
    expect(parseBestMove('bestmove (none)')).toEqual({ bestMove: null });
    expect(parseBestMove('info depth 1')).toBeNull();
  });
});

describe('pickBetter', () => {
  it('prefers the deepest multipv-1 line', () => {
    const a = parseInfo('info depth 10 score cp 5 pv e2e4')!;
    const b = parseInfo('info depth 12 score cp 7 pv d2d4')!;
    const c = parseInfo('info depth 13 multipv 2 score cp 1 pv c2c4')!;
    expect(pickBetter(null, a)).toBe(a);
    expect(pickBetter(a, b)).toBe(b);
    expect(pickBetter(b, a)).toBe(b);
    expect(pickBetter(b, c)).toBe(b);
  });
});
