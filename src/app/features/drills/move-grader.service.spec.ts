import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { EvalStoreService } from '../../core/data/eval-store.service';
import { EnginePoolService } from '../../core/engine/engine-pool.service';
import { PositionEval, positionFen, positionKey } from '../../models/position-eval';
import { MoveGraderService } from './move-grader.service';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_F3 = 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1';
const AFTER_D4 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1';

function evalOf(fen: string, cp: number, bestMove: string | null = null): PositionEval {
  return {
    key: positionKey(fen),
    fen: positionFen(fen),
    cp,
    mate: null,
    depth: 16,
    bestMove,
    pv: bestMove ?? '',
    engine: 'test',
    nodes: 0,
    evaluatedAt: 0,
  };
}

/** A store that only knows a fixed table; anything else is "unavailable". */
class FakeEvals {
  constructor(private readonly table: PositionEval[]) {}
  async getOrEvaluate(fens: string[]): Promise<Map<string, PositionEval>> {
    const out = new Map<string, PositionEval>();
    for (const fen of fens) {
      const e = this.table.find((x) => x.key === positionKey(fen));
      if (e) out.set(e.key, e);
    }
    return out;
  }
}

function setup(table: PositionEval[]): MoveGraderService {
  TestBed.configureTestingModule({
    providers: [
      { provide: EvalStoreService, useValue: new FakeEvals(table) },
      { provide: EnginePoolService, useValue: { depth: () => 16 } },
    ],
  });
  return TestBed.inject(MoveGraderService);
}

describe('MoveGraderService', () => {
  const table = [
    evalOf(START, 30, 'e2e4'),
    evalOf(AFTER_E4, 30),
    evalOf(AFTER_D4, 20),
    evalOf(AFTER_F3, -150),
  ];

  it('accepts the reference move without consulting the engine', async () => {
    const grader = setup([]);
    const r = await grader.grade(START, 'e4', 'e4', [], 'white');
    expect(r).toEqual({ ok: true, reason: 'expected', drop: 0, best: 'e4' });
  });

  it('refuses the move that was a mistake in the game and names the better one', async () => {
    const grader = setup(table);
    const r = await grader.grade(START, 'f3', 'e4', ['f3'], 'white');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('known-mistake');
    expect(r.best).toBe('e4');
  });

  it('accepts a different move that costs little', async () => {
    const grader = setup(table);
    const r = await grader.grade(START, 'd4', 'e4', [], 'white');
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('engine-approved');
    expect(r.drop).toBeGreaterThanOrEqual(0);
    expect(r.drop).toBeLessThan(10);
    expect(r.best).toBe('e4');
  });

  it('refuses a move that loses more than an inaccuracy', async () => {
    const grader = setup(table);
    const r = await grader.grade(START, 'f3', 'e4', [], 'white');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too-costly');
    expect(r.drop).toBeGreaterThanOrEqual(10);
  });

  it("measures the drop from the mover's side when Black is to move", async () => {
    // After 1.e4 (+0.30 for White), 1...e5 keeps the balance and 1...f6 hands White +1.5.
    const afterE5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1';
    const afterF6 = 'rnbqkbnr/ppppp1pp/5p2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1';
    const grader = setup([evalOf(AFTER_E4, 30, 'e7e5'), evalOf(afterE5, 30), evalOf(afterF6, 150)]);
    const fine = await grader.grade(AFTER_E4, 'e5', 'c5', [], 'black');
    expect(fine.ok).toBe(true);
    expect(fine.drop).toBeLessThan(1);
    const bad = await grader.grade(AFTER_E4, 'f6', 'c5', [], 'black');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('too-costly');
    expect(bad.best).toBe('e5');
  });

  it('reports illegal moves', async () => {
    const grader = setup(table);
    const r = await grader.grade(START, 'Ke2', null, [], 'white');
    expect(r.reason).toBe('illegal');
  });

  it('still refuses a known mistake when no evaluation is available', async () => {
    const grader = setup([]);
    const r = await grader.grade(START, 'f3', 'e4', ['f3'], 'white');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('known-mistake');
    expect(r.best).toBeNull();
  });
});
