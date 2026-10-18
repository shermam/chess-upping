import { Judgement } from '../../models/analysis';
import { Color, Game } from '../../models/game';
import { moveTimes } from '../../models/move-times';
import { Mistake } from '../../core/data/mistake-finder.service';

export type CardKind = 'repertoire' | 'mistake';

/** A position to practise, either a habitual move from the user's games or a past mistake. */
export interface DrillCard {
  /** Position key (user to move). */
  key: string;
  kind: CardKind;
  color: Color;
  /**
   * The reference answer: the user's habitual move for repertoire cards, the
   * engine's best move for mistake cards. Other moves the engine rates as
   * about as good are accepted too.
   */
  expected: string;
  /** Games in which the user had this position to move (repertoire), or times the error was made (mistake). */
  games: number;
  /** Repertoire: share of `games` in which `expected` was played. */
  share: number;
  /** Repertoire: average seconds the user spent on this move, when known. */
  avgTimeSec: number | null;
  /** Moves of a game reaching the position, for context and links. */
  line: string[];
  /** Mistake cards: the moves the user actually played here, all of which are refused. */
  played: string[];
  judgement: Judgement | null;
  opening: string | null;
  gameId: string | null;
  ply: number | null;
  /** Mistake cards: the opponent in the game where the error was made. */
  opponent: string | null;
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

/** The scheduling id of a card: repertoire cards keep the bare key for compatibility. */
export function cardStateId(card: Pick<DrillCard, 'kind' | 'key'>): string {
  return card.kind === 'repertoire' ? card.key : `m:${card.key}`;
}

interface Acc {
  color: Color;
  games: number;
  bySan: Map<string, number>;
  timeSum: number;
  timeCount: number;
  lineAt: number;
  line: string[];
}

/** Aggregates the moves played from each position by the given side. */
function aggregate(
  games: readonly Game[],
  lichessId: string,
  keysFor: (gameId: string) => readonly string[] | undefined,
  colors: readonly Color[],
  side: 'user' | 'opponent',
): Map<string, Acc> {
  const acc = new Map<string, Acc>();
  for (const game of games) {
    const color: Color | null =
      game.white.id === lichessId ? 'white' : game.black.id === lichessId ? 'black' : null;
    if (!color || !colors.includes(color)) continue;
    const keys = keysFor(game.id);
    if (!keys) continue;
    const moves = game.moves.split(' ');
    const times = moveTimes(game);
    const userFirst = color === 'white' ? 0 : 1;
    const first = side === 'user' ? userFirst : 1 - userFirst;
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
  return acc;
}

function mostPlayed(a: Acc): { san: string; count: number } {
  let san = '';
  let count = 0;
  for (const [s, n] of a.bySan) {
    if (n > count) {
      count = n;
      san = s;
    }
  }
  return { san, count };
}

/**
 * Builds repertoire cards from the user's games: for every position where the
 * user was to move, the most played reply becomes the reference answer when
 * it was played often enough. Cards are ordered slowest first (the moves
 * that cost the most clock time), then by frequency.
 */
export function buildCards(
  games: readonly Game[],
  lichessId: string,
  keysFor: (gameId: string) => readonly string[] | undefined,
  options: CardOptions = DEFAULT_CARD_OPTIONS,
): DrillCard[] {
  const cards: DrillCard[] = [];
  for (const [key, a] of aggregate(games, lichessId, keysFor, options.colors, 'user')) {
    if (a.games < options.minGames) continue;
    const { san, count } = mostPlayed(a);
    const share = count / a.games;
    if (share < options.minShare) continue;
    cards.push({
      key,
      kind: 'repertoire',
      color: a.color,
      expected: san,
      games: a.games,
      share,
      avgTimeSec: a.timeCount > 0 ? a.timeSum / a.timeCount : null,
      line: a.line,
      played: [],
      judgement: null,
      opening: null,
      gameId: null,
      ply: null,
      opponent: null,
    });
  }
  return cards.sort(
    (x, y) =>
      (y.avgTimeSec ?? -1) - (x.avgTimeSec ?? -1) ||
      y.games - x.games ||
      x.key.localeCompare(y.key),
  );
}

/** The opponent's most common reply at each position, for opening sequences. */
export interface Reply {
  san: string;
  games: number;
  share: number;
}

export function buildReplies(
  games: readonly Game[],
  lichessId: string,
  keysFor: (gameId: string) => readonly string[] | undefined,
  options: CardOptions = DEFAULT_CARD_OPTIONS,
): Map<string, Reply> {
  const replies = new Map<string, Reply>();
  for (const [key, a] of aggregate(games, lichessId, keysFor, options.colors, 'opponent')) {
    if (a.games < options.minGames) continue;
    const { san, count } = mostPlayed(a);
    replies.set(key, { san, games: a.games, share: count / a.games });
  }
  return replies;
}

/**
 * Builds cards from the mistake report: one per position where the user made
 * a mistake or blunder, the engine's best move as the reference and the moves
 * actually played as the ones to refuse. Repeated errors and blunders first.
 */
export function buildMistakeCards(
  mistakes: readonly Mistake[],
  colors: readonly Color[],
): DrillCard[] {
  const byKey = new Map<string, DrillCard>();
  for (const m of mistakes) {
    if (m.judgement === 'inaccuracy' || !m.bestSan || !colors.includes(m.color)) continue;
    const existing = byKey.get(m.keyBefore);
    if (existing) {
      existing.games++;
      if (!existing.played.includes(m.san)) existing.played.push(m.san);
      if (m.judgement === 'blunder') existing.judgement = 'blunder';
      continue;
    }
    byKey.set(m.keyBefore, {
      key: m.keyBefore,
      kind: 'mistake',
      color: m.color,
      expected: m.bestSan,
      games: 1,
      share: 1,
      avgTimeSec: null,
      line: m.lineBefore,
      played: [m.san],
      judgement: m.judgement,
      opening: m.opening === 'Unknown opening' ? null : m.opening,
      gameId: m.game.id,
      ply: m.ply,
      opponent: m.color === 'white' ? m.game.black.name : m.game.white.name,
    });
  }
  const weight = (c: DrillCard) => (c.judgement === 'blunder' ? 2 : 1);
  return [...byKey.values()].sort(
    (a, b) => b.games - a.games || weight(b) - weight(a) || a.key.localeCompare(b.key),
  );
}

/**
 * Removes repertoire cards whose habitual move is one of the user's recorded
 * mistakes at that position, so the two kinds of card never contradict.
 */
export function withoutBadHabits(
  repertoire: readonly DrillCard[],
  mistakes: readonly DrillCard[],
): DrillCard[] {
  const bad = new Map<string, readonly string[]>();
  for (const m of mistakes) bad.set(m.key, m.played);
  return repertoire.filter((c) => !bad.get(c.key)?.includes(c.expected));
}
