/** Parsed `info` line from a UCI engine, scores relative to the side to move. */
export interface UciInfo {
  depth: number;
  multipv: number;
  cp: number | null;
  mate: number | null;
  nodes: number;
  pv: string[];
}

/**
 * Parses an `info` line. Returns null for lines without a score (currmove
 * progress, string messages) so callers can ignore them.
 */
export function parseInfo(line: string): UciInfo | null {
  if (!line.startsWith('info ') || line.includes(' currmove ') || line.includes(' string '))
    return null;
  const depth = /\bdepth (\d+)/.exec(line);
  const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
  if (!depth || !score) return null;
  const multipv = /\bmultipv (\d+)/.exec(line);
  const nodes = /\bnodes (\d+)/.exec(line);
  const pv = /\bpv (.+)$/.exec(line);
  return {
    depth: Number(depth[1]),
    multipv: multipv ? Number(multipv[1]) : 1,
    cp: score[1] === 'cp' ? Number(score[2]) : null,
    mate: score[1] === 'mate' ? Number(score[2]) : null,
    nodes: nodes ? Number(nodes[1]) : 0,
    pv: pv ? pv[1].trim().split(/\s+/) : [],
  };
}

/** Parses a `bestmove` line; null when the engine has no move (mate/stalemate). */
export function parseBestMove(line: string): { bestMove: string | null } | null {
  const m = /^bestmove (\S+)/.exec(line);
  if (!m) return null;
  return { bestMove: m[1] === '(none)' ? null : m[1] };
}

/** Keeps the deepest principal-variation info seen so far. */
export function pickBetter(current: UciInfo | null, next: UciInfo): UciInfo {
  if (next.multipv !== 1) return current ?? next;
  if (!current || next.depth >= current.depth) return next;
  return current;
}
