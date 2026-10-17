import { Color, Game, GamePlayer, GameResult } from '../../models/game';
import { moveTimes } from '../../models/move-times';

export type ResultFilter = 'all' | GameResult;
export type SortBy = 'games' | 'score' | 'recent' | 'time';

export interface TreeFilters {
  /** Which colour the user played. The tree is always from one side. */
  color: Color;
  /** Perf types to include; empty means all. */
  perfs: ReadonlySet<string>;
  rated: 'all' | 'rated' | 'casual';
  result: ResultFilter;
  /** Only games created at or after this time (epoch ms); null for all time. */
  since: number | null;
  /** Opponent rating bounds, inclusive; null for no bound. */
  ratingMin: number | null;
  ratingMax: number | null;
}

export const DEFAULT_FILTERS: TreeFilters = {
  color: 'white',
  perfs: new Set(),
  rated: 'all',
  result: 'all',
  since: null,
  ratingMin: null,
  ratingMax: null,
};

/** A game pre-processed for tree walking: moves split and result from the user's side. */
export interface TreeGame {
  game: Game;
  moves: string[];
  /** Seconds spent on each ply, null where unknown. */
  times: (number | null)[];
  result: GameResult;
  opponent: GamePlayer;
}

export interface Tally {
  games: number;
  wins: number;
  draws: number;
  losses: number;
}

export interface MoveStats extends Tally {
  san: string;
  avgOpponentRating: number | null;
  lastPlayed: number;
  /** Average seconds spent on this move by whoever played it at this node. */
  avgTimeSec: number | null;
  timeSamples: number;
}

export function resultFor(game: Game, color: Color): GameResult {
  if (game.winner === null) return 'draw';
  return game.winner === color ? 'win' : 'loss';
}

/** Selects and prepares the games matching the filters for `lichessId`. */
export function prepareGames(
  games: readonly Game[],
  lichessId: string,
  filters: TreeFilters,
): TreeGame[] {
  const out: TreeGame[] = [];
  for (const game of games) {
    const me = game[filters.color];
    if (!me || me.id !== lichessId) continue;
    if (filters.perfs.size > 0 && !filters.perfs.has(game.perf)) continue;
    if (filters.rated === 'rated' && !game.rated) continue;
    if (filters.rated === 'casual' && game.rated) continue;
    if (filters.since !== null && game.createdAt < filters.since) continue;
    const result = resultFor(game, filters.color);
    if (filters.result !== 'all' && result !== filters.result) continue;
    const opponent = filters.color === 'white' ? game.black : game.white;
    if (
      filters.ratingMin !== null &&
      (opponent.rating === null || opponent.rating < filters.ratingMin)
    )
      continue;
    if (
      filters.ratingMax !== null &&
      (opponent.rating === null || opponent.rating > filters.ratingMax)
    )
      continue;
    out.push({
      game,
      moves: game.moves.split(' '),
      times: moveTimes(game),
      result,
      opponent,
    });
  }
  return out;
}

/** A game at a node of the tree, with the index of the move it plays next from there. */
export interface NodeEntry {
  game: TreeGame;
  ply: number;
}

/** Games whose first moves match `line`, each continuing at `line.length`. */
export function entriesAtLine(games: readonly TreeGame[], line: readonly string[]): NodeEntry[] {
  return gamesAtLine(games, line).map((game) => ({ game, ply: line.length }));
}

/**
 * Games that reached the position `key` by any move order, each continuing
 * from its first visit to it. `keysFor` returns a game's positions by ply.
 */
export function entriesAtPosition(
  games: readonly TreeGame[],
  key: string,
  keysFor: (gameId: string) => readonly string[] | undefined,
): NodeEntry[] {
  const out: NodeEntry[] = [];
  for (const game of games) {
    const keys = keysFor(game.game.id);
    if (!keys) continue;
    const ply = keys.indexOf(key);
    if (ply >= 0) out.push({ game, ply });
  }
  return out;
}

/** Keeps the games whose first moves match `line` exactly. */
export function gamesAtLine(games: readonly TreeGame[], line: readonly string[]): TreeGame[] {
  if (line.length === 0) return [...games];
  return games.filter((g) => {
    if (g.moves.length < line.length) return false;
    for (let i = 0; i < line.length; i++) if (g.moves[i] !== line[i]) return false;
    return true;
  });
}

export function tally(games: readonly TreeGame[]): Tally {
  const t: Tally = { games: games.length, wins: 0, draws: 0, losses: 0 };
  for (const g of games) {
    if (g.result === 'win') t.wins++;
    else if (g.result === 'draw') t.draws++;
    else t.losses++;
  }
  return t;
}

/** Score in [0, 1]: a win counts 1, a draw a half. */
export function score(t: Tally): number {
  return t.games === 0 ? 0 : (t.wins + t.draws / 2) / t.games;
}

/** Aggregates the move played at `ply` across games already filtered to a line. */
export function nextMoveStats(games: readonly TreeGame[], ply: number): MoveStats[] {
  return nextMoveStatsFrom(games.map((game) => ({ game, ply })));
}

/** Aggregates the next move of each entry, whatever ply it continues from. */
export function nextMoveStatsFrom(entries: readonly NodeEntry[]): MoveStats[] {
  const byMove = new Map<
    string,
    MoveStats & { ratingSum: number; ratingCount: number; timeSum: number }
  >();
  for (const { game: g, ply } of entries) {
    const san = g.moves[ply];
    if (!san) continue;
    let stats = byMove.get(san);
    if (!stats) {
      stats = {
        san,
        games: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        avgOpponentRating: null,
        lastPlayed: 0,
        avgTimeSec: null,
        timeSamples: 0,
        ratingSum: 0,
        ratingCount: 0,
        timeSum: 0,
      };
      byMove.set(san, stats);
    }
    stats.games++;
    if (g.result === 'win') stats.wins++;
    else if (g.result === 'draw') stats.draws++;
    else stats.losses++;
    if (g.opponent.rating !== null) {
      stats.ratingSum += g.opponent.rating;
      stats.ratingCount++;
    }
    const t = g.times[ply];
    if (t !== null && t !== undefined) {
      stats.timeSum += t;
      stats.timeSamples++;
    }
    if (g.game.createdAt > stats.lastPlayed) stats.lastPlayed = g.game.createdAt;
  }
  return [...byMove.values()].map(({ ratingSum, ratingCount, timeSum, ...stats }) => ({
    ...stats,
    avgOpponentRating: ratingCount > 0 ? Math.round(ratingSum / ratingCount) : null,
    avgTimeSec: stats.timeSamples > 0 ? timeSum / stats.timeSamples : null,
  }));
}

export function sortStats(stats: readonly MoveStats[], by: SortBy): MoveStats[] {
  const sorted = [...stats];
  const tie = (a: MoveStats, b: MoveStats) => b.games - a.games || a.san.localeCompare(b.san);
  switch (by) {
    case 'score':
      return sorted.sort((a, b) => score(b) - score(a) || tie(a, b));
    case 'recent':
      return sorted.sort((a, b) => b.lastPlayed - a.lastPlayed || tie(a, b));
    case 'time':
      return sorted.sort((a, b) => (b.avgTimeSec ?? -1) - (a.avgTimeSec ?? -1) || tie(a, b));
    default:
      return sorted.sort(tie);
  }
}

/**
 * How a move's score compares with the node as a whole: 'good' or 'poor'
 * when it differs by at least ten points over a handful of games.
 */
export function scoreClass(move: Tally, node: Tally): 'good' | 'poor' | null {
  if (move.games < 3 || node.games < 5) return null;
  const diff = score(move) - score(node);
  if (diff >= 0.1) return 'good';
  if (diff <= -0.1) return 'poor';
  return null;
}

export function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}
