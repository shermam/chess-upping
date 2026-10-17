export type Color = 'white' | 'black';
export type GameResult = 'win' | 'draw' | 'loss';

/** One side of a game. `id` is null for anonymous and computer opponents. */
export interface GamePlayer {
  name: string;
  id: string | null;
  rating: number | null;
  ratingDiff: number | null;
}

/**
 * A finished standard-chess game as stored in the shared Firestore `games`
 * collection and mirrored in the local IndexedDB store. The document id is
 * the Lichess game id, so the same game uploaded by both players collapses
 * into a single document.
 */
export interface Game {
  id: string;
  rated: boolean;
  variant: string;
  speed: string;
  perf: string;
  createdAt: number;
  lastMoveAt: number;
  status: string;
  winner: Color | null;
  /** Lowercase Lichess ids of the human players, used for lookups. */
  players: string[];
  white: GamePlayer;
  black: GamePlayer;
  /** SAN moves separated by single spaces. */
  moves: string;
  opening: { eco: string; name: string; ply: number } | null;
  clock: { initial: number; increment: number } | null;
  source: string | null;
}

/** The local copy adds an upload flag (IndexedDB cannot index booleans). */
export interface LocalGame extends Game {
  pendingUpload: 0 | 1;
}

/** Perf types that are standard chess, in the order the UI shows them. */
export const STANDARD_PERFS = [
  'ultraBullet',
  'bullet',
  'blitz',
  'rapid',
  'classical',
  'correspondence',
] as const;

export type StandardPerf = (typeof STANDARD_PERFS)[number];

export const PERF_LABELS: Record<StandardPerf, string> = {
  ultraBullet: 'UltraBullet',
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapid',
  classical: 'Classical',
  correspondence: 'Correspondence',
};
