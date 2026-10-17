import { Injectable } from '@angular/core';

export type ExplorerSource = 'masters' | 'lichess';

export interface ExplorerMove {
  uci: string;
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating?: number;
}

export interface ExplorerResult {
  white: number;
  draws: number;
  black: number;
  moves: ExplorerMove[];
  opening?: { eco: string; name: string } | null;
}

export interface ExplorerOptions {
  /** Lichess database only: game speeds to include. */
  speeds?: readonly string[];
  /** Lichess database only: rating buckets (0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500). */
  ratings?: readonly number[];
}

const BASE = 'https://explorer.lichess.org';
export const EXPLORER_RATINGS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500] as const;

/**
 * Read-only client for the public Lichess opening explorer, used to compare
 * the user's own statistics with master games and the Lichess player pool.
 * Results are cached per request for the session; the service is rate
 * limited, so callers debounce.
 */
@Injectable({ providedIn: 'root' })
export class LichessExplorerService {
  private readonly cache = new Map<string, Promise<ExplorerResult>>();

  query(
    source: ExplorerSource,
    fen: string,
    options: ExplorerOptions = {},
  ): Promise<ExplorerResult> {
    const params = new URLSearchParams({ fen, moves: '12', topGames: '0' });
    if (source === 'lichess') {
      params.set('variant', 'standard');
      params.set('recentGames', '0');
      if (options.speeds?.length) params.set('speeds', options.speeds.join(','));
      if (options.ratings?.length) params.set('ratings', options.ratings.join(','));
    }
    const url = `${BASE}/${source}?${params}`;
    let pending = this.cache.get(url);
    if (!pending) {
      pending = this.fetch(url);
      this.cache.set(url, pending);
      pending.catch(() => this.cache.delete(url));
    }
    return pending;
  }

  private async fetch(url: string): Promise<ExplorerResult> {
    const response = await globalThis.fetch(url, { headers: { Accept: 'application/json' } });
    if (response.status === 429) {
      throw new Error('The Lichess explorer is rate limiting requests; try again in a minute.');
    }
    if (!response.ok) throw new Error(`Lichess explorer returned HTTP ${response.status}`);
    const body = (await response.json()) as ExplorerResult;
    return {
      white: body.white ?? 0,
      draws: body.draws ?? 0,
      black: body.black ?? 0,
      moves: (body.moves ?? []).map((m) => ({
        uci: m.uci,
        san: m.san,
        white: m.white ?? 0,
        draws: m.draws ?? 0,
        black: m.black ?? 0,
        averageRating: m.averageRating,
      })),
      opening: body.opening ?? null,
    };
  }
}
