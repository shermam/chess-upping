import { Color, Game } from '../../models/game';
import { moveTimes } from '../../models/move-times';

/** A position from the user's own games where they have a habitual move. */
export interface DrillCard {
  key: string;
  color: Color;
  /** SAN of the move the user plays most often here. */
  expected: string;
  /** Games in which the user had this position to move. */
  games: number;
  /** Share of `games` in which `expected` was played, 0–1. */
  share: number;
  /** Average seconds the user spent on this move, when known. */
  avgTimeSec: number | null;
  /** Moves of the most recent game reaching the position, for context and links. */
  line: string[];
}

export interface CardOptions {
  minGames: number;
  /** Minimum share for the most played move to count as a habit. */
  minShare: number;
  colors: readonly Color[];
}

export const DEFAULT_CARD_OPTIONS: CardOptions = {
  minGames: 3,
  minShare: 0.5,
  colors: ['white', 'black'],
};

interface Acc {
  color: Color;
  games: number;
  bySan: Map<string, number>;
  timeSum: number;
  timeCount: number;
  lineAt: number;
  line: string[];
}

/**
 * Builds drill cards from the user's games: for every position where the
 * user was to move, the most played reply becomes the expected answer when
 * it was played often enough. Cards are ordered slowest first (the moves
 * that cost the most clock time), then by frequency.
 */
export function buildCards(
  games: readonly Game[],
  lichessId: string,
  keysFor: (gameId: string) => readonly string[] | undefined,
  options: CardOptions = DEFAULT_CARD_OPTIONS,
): DrillCard[] {
  const acc = new Map<string, Acc>();
  for (const game of games) {
    const color: Color | null =
      game.white.id === lichessId ? 'white' : game.black.id === lichessId ? 'black' : null;
    if (!color || !options.colors.includes(color)) continue;
    const keys = keysFor(game.id);
    if (!keys) continue;
    const moves = game.moves.split(' ');
    const times = moveTimes(game);
    const first = color === 'white' ? 0 : 1;
    for (let p = first; p < moves.length && p < keys.length; p += 2) {
      const key = keys[p];
      let a = acc.get(key);
      if (!a) {
        a = { color, games: 0, bySan: new Map(), timeSum: 0, timeCount: 0, lineAt: -1, line: [] };
        acc.set(key, a);
      }
      a.games++;
      a.bySan.set(moves[p], (a.bySan.get(moves[p]) ?? 0) + 1);
      const t = times[p];
      if (t !== null && t !== undefined) {
        a.timeSum += t;
        a.timeCount++;
      }
      if (game.createdAt > a.lineAt) {
        a.lineAt = game.createdAt;
        a.line = moves.slice(0, p);
      }
    }
  }
  const cards: DrillCard[] = [];
  for (const [key, a] of acc) {
    if (a.games < options.minGames) continue;
    let expected = '';
    let best = 0;
    for (const [san, n] of a.bySan) {
      if (n > best) {
        best = n;
        expected = san;
      }
    }
    const share = best / a.games;
    if (share < options.minShare) continue;
    cards.push({
      key,
      color: a.color,
      expected,
      games: a.games,
      share,
      avgTimeSec: a.timeCount > 0 ? a.timeSum / a.timeCount : null,
      line: a.line,
    });
  }
  return cards.sort(
    (x, y) =>
      (y.avgTimeSec ?? -1) - (x.avgTimeSec ?? -1) ||
      y.games - x.games ||
      x.key.localeCompare(y.key),
  );
}
