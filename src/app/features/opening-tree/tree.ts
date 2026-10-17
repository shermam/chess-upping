import { Color, Game, GamePlayer, GameResult } from '../../models/game';

export interface TreeFilters {
  /** Which colour the user played. The tree is always from one side. */
  color: Color;
  /** Perf types to include; empty means all. */
  perfs: ReadonlySet<string>;
  rated: 'all' | 'rated' | 'casual';
}

/** A game pre-processed for tree walking: moves split and result from the user's side. */
export interface TreeGame {
  game: Game;
  moves: string[];
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
    out.push({
      game,
      moves: game.moves.split(' '),
      result: resultFor(game, filters.color),
      opponent: filters.color === 'white' ? game.black : game.white,
    });
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

/** Aggregates the move played at `ply` across games already filtered to a line, most played first. */
export function nextMoveStats(games: readonly TreeGame[], ply: number): MoveStats[] {
  const byMove = new Map<string, MoveStats & { ratingSum: number; ratingCount: number }>();
  for (const g of games) {
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
        ratingSum: 0,
        ratingCount: 0,
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
    if (g.game.createdAt > stats.lastPlayed) stats.lastPlayed = g.game.createdAt;
  }
  return [...byMove.values()]
    .map(({ ratingSum, ratingCount, ...stats }) => ({
      ...stats,
      avgOpponentRating: ratingCount > 0 ? Math.round(ratingSum / ratingCount) : null,
    }))
    .sort((a, b) => b.games - a.games || a.san.localeCompare(b.san));
}

export function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}
