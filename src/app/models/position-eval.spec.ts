import { describe, expect, it } from 'vitest';
import { formatEval, positionKey, toWhitePov, whiteWinChance } from './position-eval';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('positionKey', () => {
  it('drops the move counters and replaces slashes', () => {
    expect(positionKey(START)).toBe('rnbqkbnr_pppppppp_8_8_8_8_PPPPPPPP_RNBQKBNR w KQkq -');
    expect(positionKey(START.replace('0 1', '7 42'))).toBe(positionKey(START));
  });
});

describe('toWhitePov', () => {
  it('keeps scores with White to move and negates them with Black to move', () => {
    expect(toWhitePov({ cp: 35, mate: null }, START)).toEqual({ cp: 35, mate: null });
    const black = START.replace(' w ', ' b ');
    expect(toWhitePov({ cp: 35, mate: null }, black)).toEqual({ cp: -35, mate: null });
    expect(toWhitePov({ cp: null, mate: 3 }, black)).toEqual({ cp: null, mate: -3 });
  });
});

describe('formatEval', () => {
  it('formats centipawns and mates', () => {
    expect(formatEval({ cp: 35, mate: null, fen: START })).toBe('+0.35');
    expect(formatEval({ cp: -120, mate: null, fen: START })).toBe('-1.20');
    expect(formatEval({ cp: 0, mate: null, fen: START })).toBe('0.00');
    expect(formatEval({ cp: null, mate: 4, fen: START })).toBe('#4');
    expect(formatEval({ cp: null, mate: -3, fen: START })).toBe('#-3');
    expect(formatEval({ cp: null, mate: 0, fen: START })).toBe('0-1');
    expect(formatEval({ cp: null, mate: 0, fen: START.replace(' w ', ' b ') })).toBe('1-0');
  });
});

describe('whiteWinChance', () => {
  it('is symmetric around a level position and saturates on mates', () => {
    expect(whiteWinChance({ cp: 0, mate: null, fen: START })).toBeCloseTo(0.5);
    const up = whiteWinChance({ cp: 200, mate: null, fen: START });
    const down = whiteWinChance({ cp: -200, mate: null, fen: START });
    expect(up).toBeGreaterThan(0.6);
    expect(up + down).toBeCloseTo(1);
    expect(whiteWinChance({ cp: null, mate: 2, fen: START })).toBe(1);
    expect(whiteWinChance({ cp: null, mate: -2, fen: START })).toBe(0);
  });
});
