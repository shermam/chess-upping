import { Injectable, inject } from '@angular/core';
import { Chess } from 'chess.js';
import { EvalStoreService } from '../../core/data/eval-store.service';
import { EnginePoolService } from '../../core/engine/engine-pool.service';
import { chancesFor } from '../../models/analysis';
import { Color } from '../../models/game';
import { PositionEval, positionKey } from '../../models/position-eval';

export interface GradeResult {
  ok: boolean;
  /** Why it was accepted or refused. */
  reason: 'expected' | 'engine-approved' | 'known-mistake' | 'too-costly' | 'illegal';
  /** Winning-chance points lost by the move, when evaluated. */
  drop: number | null;
  /** Engine's best move in SAN from the position, when known. */
  best: string | null;
}

/** A move losing at least this many points of winning chance is refused (the inaccuracy threshold). */
export const MAX_ACCEPTED_DROP = 10;

/**
 * Judges a drill answer: the reference move is always right, a move the user
 * is known to have blundered with is always wrong, and anything else is
 * accepted when the engine says it costs less than an inaccuracy.
 */
@Injectable({ providedIn: 'root' })
export class MoveGraderService {
  private readonly evals = inject(EvalStoreService);
  private readonly pool = inject(EnginePoolService);

  async grade(
    fen: string,
    san: string,
    expected: string | null,
    forbidden: string | null,
    color: Color,
  ): Promise<GradeResult> {
    if (expected !== null && san === expected)
      return { ok: true, reason: 'expected', drop: 0, best: expected };
    if (forbidden !== null && san === forbidden) {
      const before = await this.evaluate(fen).catch(() => null);
      return {
        ok: false,
        reason: 'known-mistake',
        drop: null,
        best: before ? bestSan(fen, before) : null,
      };
    }
    const chess = new Chess(fen);
    let after: string;
    try {
      chess.move(san);
      after = chess.fen();
    } catch {
      return { ok: false, reason: 'illegal', drop: null, best: null };
    }
    const [beforeEval, afterEval] = await Promise.all([this.evaluate(fen), this.evaluate(after)]);
    const drop = Math.max(0, chancesFor(beforeEval, color) - chancesFor(afterEval, color));
    const best = bestSan(fen, beforeEval);
    return drop < MAX_ACCEPTED_DROP
      ? { ok: true, reason: 'engine-approved', drop, best }
      : { ok: false, reason: 'too-costly', drop, best };
  }

  /** Engine evaluation of a position, from the cache when available, at the configured depth. */
  private async evaluate(fen: string): Promise<PositionEval> {
    const result = await this.evals.getOrEvaluate([fen], this.pool.depth(), 'high');
    const e = result.get(positionKey(fen));
    if (!e) throw new Error('No evaluation available');
    return e;
  }
}

function bestSan(fen: string, e: PositionEval): string | null {
  if (!e.bestMove) return null;
  try {
    return new Chess(fen).move({
      from: e.bestMove.slice(0, 2),
      to: e.bestMove.slice(2, 4),
      promotion: e.bestMove[4],
    }).san;
  } catch {
    return null;
  }
}
