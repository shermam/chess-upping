import { Color } from './game';
import { PositionEval, sideToMove, whiteWinChance } from './position-eval';

export type Judgement = 'inaccuracy' | 'mistake' | 'blunder';

/** A played move compared with the engine's view of the positions before and after it. */
export interface JudgedMove {
  /** 1-based ply of the move (1 = White's first move). */
  ply: number;
  san: string;
  color: Color;
  /** Mover's winning chances before and after the move, 0–100. */
  before: number;
  after: number;
  /** Percentage points of winning chance lost by the move (never negative). */
  drop: number;
  judgement: Judgement | null;
  /** Engine's preferred move in the position before, UCI. */
  bestMove: string | null;
}

export interface PlyForJudgement {
  fen: string;
  key: string;
  san: string | null;
}

/** Thresholds in percentage points of winning chance, as used by Lichess. */
export const JUDGEMENT_THRESHOLDS: { judgement: Judgement; drop: number }[] = [
  { judgement: 'blunder', drop: 30 },
  { judgement: 'mistake', drop: 20 },
  { judgement: 'inaccuracy', drop: 10 },
];

export const JUDGEMENT_SYMBOL: Record<Judgement, string> = {
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
};

export function judgementFor(drop: number): Judgement | null {
  for (const t of JUDGEMENT_THRESHOLDS) if (drop >= t.drop) return t.judgement;
  return null;
}

/** Winning chances of the given side, 0–100. */
export function chancesFor(e: PositionEval, color: Color): number {
  const white = whiteWinChance(e) * 100;
  return color === 'white' ? white : 100 - white;
}

/**
 * Judges every move of a game for which both surrounding positions have an
 * evaluation. `plies[0]` is the start position; `plies[i]` the position after
 * ply i with the move that led to it.
 */
export function judgeMoves(
  plies: readonly PlyForJudgement[],
  evals: ReadonlyMap<string, PositionEval>,
): JudgedMove[] {
  const out: JudgedMove[] = [];
  for (let i = 1; i < plies.length; i++) {
    const beforeEval = evals.get(plies[i - 1].key);
    const afterEval = evals.get(plies[i].key);
    const san = plies[i].san;
    if (!beforeEval || !afterEval || !san) continue;
    const color = sideToMove(plies[i - 1].fen);
    const before = chancesFor(beforeEval, color);
    const after = chancesFor(afterEval, color);
    const drop = Math.max(0, before - after);
    out.push({
      ply: i,
      san,
      color,
      before,
      after,
      drop,
      judgement: judgementFor(drop),
      bestMove: beforeEval.bestMove,
    });
  }
  return out;
}

/** Accuracy in the Lichess style: average of per-move accuracies from the chance drop. */
export function accuracy(moves: readonly JudgedMove[], color: Color): number | null {
  const own = moves.filter((m) => m.color === color);
  if (own.length === 0) return null;
  const sum = own.reduce((acc, m) => {
    const before = m.before;
    const after = m.after;
    // Lichess: 103.1668 * exp(-0.04354 * (winBefore - winAfter)) - 3.1669, clamped.
    const a = 103.1668 * Math.exp(-0.04354 * Math.max(0, before - after)) - 3.1669;
    return acc + Math.max(0, Math.min(100, a));
  }, 0);
  return Math.round((sum / own.length) * 10) / 10;
}
