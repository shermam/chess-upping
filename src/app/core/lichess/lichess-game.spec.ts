import { describe, expect, it } from 'vitest';
import { LichessGameJson, parseLichessGame, parseNdjson } from './lichess-game';

const sample: LichessGameJson = {
  id: 'q7ZvsdUF',
  rated: true,
  variant: 'standard',
  speed: 'blitz',
  perf: 'blitz',
  createdAt: 1514505150384,
  lastMoveAt: 1514505592843,
  status: 'draw',
  source: 'pool',
  players: {
    white: {
      user: { name: 'Lance5500', id: 'lance5500', title: 'LM' },
      rating: 2389,
      ratingDiff: 4,
    },
    black: { user: { name: 'TryingHard87', id: 'tryinghard87' }, rating: 2498, ratingDiff: -4 },
  },
  opening: { eco: 'D31', name: 'Semi-Slav Defense: Marshall Gambit', ply: 7 },
  moves: 'd4 d5 c4 c6 Nc3 e6 e4 Nd7',
  clock: { initial: 300, increment: 3, totalTime: 420 },
  clocks: [30000, 30000, 29800, 29500, 29600, 29100, 29400, 28800],
};

describe('parseLichessGame', () => {
  it('maps a standard game', () => {
    const game = parseLichessGame(sample);
    expect(game).not.toBeNull();
    expect(game!.id).toBe('q7ZvsdUF');
    expect(game!.players).toEqual(['lance5500', 'tryinghard87']);
    expect(game!.white.name).toBe('Lance5500');
    expect(game!.black.rating).toBe(2498);
    expect(game!.winner).toBeNull();
    expect(game!.opening?.eco).toBe('D31');
    expect(game!.clock).toEqual({ initial: 300, increment: 3 });
    expect(game!.moves).toBe('d4 d5 c4 c6 Nc3 e6 e4 Nd7');
    expect(game!.clocks).toEqual([30000, 30000, 29800, 29500, 29600, 29100, 29400, 28800]);
  });

  it('stores null clocks when Lichess sends none, an empty list, or a broken list', () => {
    expect(parseLichessGame({ ...sample, clocks: undefined })!.clocks).toBeNull();
    expect(parseLichessGame({ ...sample, clocks: [] })!.clocks).toBeNull();
    expect(
      parseLichessGame({ ...sample, clocks: [100, null as unknown as number, 90] })!.clocks,
    ).toBeNull();
  });

  it('drops non-standard variants and move-less games', () => {
    expect(parseLichessGame({ ...sample, variant: 'chess960' })).toBeNull();
    expect(parseLichessGame({ ...sample, moves: '' })).toBeNull();
  });

  it('handles computer and anonymous opponents', () => {
    const game = parseLichessGame({
      ...sample,
      players: { white: sample.players.white, black: { aiLevel: 3 } },
    });
    expect(game!.players).toEqual(['lance5500']);
    expect(game!.black).toEqual({
      name: 'Stockfish level 3',
      id: null,
      rating: null,
      ratingDiff: null,
    });
    const anon = parseLichessGame({
      ...sample,
      players: { white: {}, black: sample.players.black },
    });
    expect(anon!.white.name).toBe('Anonymous');
    expect(anon!.players).toEqual(['tryinghard87']);
  });

  it('never leaves undefined fields (Firestore rejects them)', () => {
    const game = parseLichessGame({
      ...sample,
      opening: undefined,
      clock: undefined,
      source: undefined,
    });
    for (const value of Object.values(game!)) expect(value).not.toBeUndefined();
  });
});

describe('parseNdjson', () => {
  it('splits records across chunk boundaries', async () => {
    const text = '{"a":1}\n{"a":2}\n\n{"a":3}';
    const encoded = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 5));
        controller.enqueue(encoded.slice(5, 13));
        controller.enqueue(encoded.slice(13));
        controller.close();
      },
    });
    const out: { a: number }[] = [];
    for await (const rec of parseNdjson<{ a: number }>(stream)) out.push(rec);
    expect(out.map((r) => r.a)).toEqual([1, 2, 3]);
  });
});
