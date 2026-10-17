/**
 * Engine evaluation of a single chess position, always expressed from
 * White's point of view. Exactly one of `cp` and `mate` is set.
 */
export interface PositionEval {
  /** Firestore document id, derived from the FEN by `positionKey`. */
  key: string;
  /** The position: the first four FEN fields (no move counters). */
  fen: string;
  /** Centipawns for White, or null when a forced mate was found. */
  cp: number | null;
  /** Moves to mate: positive means White mates, negative means Black mates, 0 = mated now. */
  mate: number | null;
  depth: number;
  /** Best move in UCI notation, null for terminal positions. */
  bestMove: string | null;
  /** Principal variation in UCI notation, space separated, at most ten moves. */
  pv: string;
  engine: string;
  nodes: number;
  /** When the evaluation was computed, in epoch milliseconds (client clock). */
  evaluatedAt: number;
}

export interface LocalPositionEval extends PositionEval {
  pendingUpload: 0 | 1;
}

/** Marks a game whose positions have all been evaluated to at least `depth`. */
export interface GameEvalRecord {
  gameId: string;
  depth: number;
  positions: number;
  evaluatedAt: number;
}

export const ENGINE_NAME = 'stockfish-19-lite';
/** Depth recorded for positions that need no search (mate, stalemate, dead draws). */
export const TERMINAL_DEPTH = 99;
export const MAX_PV_MOVES = 10;

/** The part of a FEN that identifies a position: placement, side to move, castling, en passant. */
export function positionFen(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

/**
 * Document id for a position. Firestore ids cannot contain `/`, so the rank
 * separators become `_`; everything else in a FEN is id-safe.
 */
export function positionKey(fen: string): string {
  return positionFen(fen).replace(/\//g, '_');
}

export function sideToMove(fen: string): 'white' | 'black' {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

/**
 * Converts a UCI score, which is relative to the side to move, into White's
 * point of view.
 */
export function toWhitePov(
  score: { cp: number | null; mate: number | null },
  fen: string,
): { cp: number | null; mate: number | null } {
  if (sideToMove(fen) === 'white') return { cp: score.cp, mate: score.mate };
  return {
    cp: score.cp === null ? null : -score.cp,
    mate: score.mate === null ? null : -score.mate,
  };
}

/** Human-readable score from White's side: `+0.35`, `-1.20`, `#4`, `#-3`, `0-1`. */
export function formatEval(e: Pick<PositionEval, 'cp' | 'mate' | 'fen'>): string {
  if (e.mate !== null) {
    if (e.mate === 0) return sideToMove(e.fen) === 'white' ? '0-1' : '1-0';
    return `#${e.mate}`;
  }
  const pawns = (e.cp ?? 0) / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

/**
 * White's winning chances in [0, 1], using Lichess's logistic mapping of
 * centipawns so an eval bar and a graph compress large advantages sensibly.
 */
export function whiteWinChance(e: Pick<PositionEval, 'cp' | 'mate' | 'fen'>): number {
  if (e.mate !== null) {
    if (e.mate === 0) return sideToMove(e.fen) === 'white' ? 0 : 1;
    return e.mate > 0 ? 1 : 0;
  }
  const cp = Math.max(-1500, Math.min(1500, e.cp ?? 0));
  return 1 / (1 + Math.exp(-0.00368208 * cp));
}
