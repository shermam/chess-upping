import { Game, GamePlayer } from '../../models/game';

/** Shape of one line of the NDJSON stream from `GET /api/games/user/{username}`. */
export interface LichessGameJson {
  id: string;
  rated: boolean;
  variant: string;
  speed: string;
  perf: string;
  createdAt: number;
  lastMoveAt: number;
  status: string;
  source?: string;
  winner?: 'white' | 'black';
  players: {
    white: LichessPlayerJson;
    black: LichessPlayerJson;
  };
  opening?: { eco: string; name: string; ply: number };
  moves?: string;
  clock?: { initial: number; increment: number; totalTime?: number };
  clocks?: number[];
}

export interface LichessPlayerJson {
  user?: { name: string; id: string; title?: string };
  rating?: number;
  ratingDiff?: number;
  aiLevel?: number;
  name?: string;
}

/** Clock readings are kept only when complete: a dropped entry would shift every later ply. */
function validClocks(clocks: unknown): number[] | null {
  if (!Array.isArray(clocks) || clocks.length === 0) return null;
  return clocks.every((c) => Number.isInteger(c) && c >= 0) ? (clocks as number[]) : null;
}

function toPlayer(p: LichessPlayerJson | undefined): GamePlayer {
  if (!p) return { name: 'Anonymous', id: null, rating: null, ratingDiff: null };
  if (p.user) {
    return {
      name: p.user.name,
      id: p.user.id.toLowerCase(),
      rating: p.rating ?? null,
      ratingDiff: p.ratingDiff ?? null,
    };
  }
  if (p.aiLevel !== undefined) {
    return { name: `Stockfish level ${p.aiLevel}`, id: null, rating: null, ratingDiff: null };
  }
  return { name: p.name ?? 'Anonymous', id: null, rating: p.rating ?? null, ratingDiff: null };
}

/**
 * Converts a Lichess export record into the app's `Game` shape.
 * Returns null for games the app does not keep: non-standard variants and
 * games without a single move (aborted before the first move).
 */
export function parseLichessGame(raw: LichessGameJson): Game | null {
  if (raw.variant !== 'standard') return null;
  const moves = (raw.moves ?? '').trim();
  if (!moves) return null;
  const white = toPlayer(raw.players?.white);
  const black = toPlayer(raw.players?.black);
  const players = [white.id, black.id].filter((id): id is string => id !== null);
  return {
    id: raw.id,
    rated: !!raw.rated,
    variant: raw.variant,
    speed: raw.speed,
    perf: raw.perf,
    createdAt: raw.createdAt,
    lastMoveAt: raw.lastMoveAt ?? raw.createdAt,
    status: raw.status,
    winner: raw.winner ?? null,
    players,
    white,
    black,
    moves,
    opening: raw.opening
      ? { eco: raw.opening.eco, name: raw.opening.name, ply: raw.opening.ply }
      : null,
    clock: raw.clock ? { initial: raw.clock.initial, increment: raw.clock.increment } : null,
    source: raw.source ?? null,
    clocks: validClocks(raw.clocks),
  };
}

/** Splits an NDJSON byte stream into parsed JSON objects, one per line. */
export async function* parseNdjson<T>(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as T;
        newline = buffer.indexOf('\n');
      }
    }
    const rest = buffer.trim();
    if (rest) yield JSON.parse(rest) as T;
  } finally {
    // Stop the download if the consumer gave up before the end.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
