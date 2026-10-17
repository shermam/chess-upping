import { Injectable } from '@angular/core';
import { STANDARD_PERFS } from '../../models/game';
import { LichessGameJson, parseNdjson } from './lichess-game';

const API = 'https://lichess.org/api';

export interface LichessAccount {
  id: string;
  username: string;
}

export class LichessApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

@Injectable({ providedIn: 'root' })
export class LichessApiService {
  async account(token: string): Promise<LichessAccount> {
    const response = await fetch(`${API}/account`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new LichessApiError(
        `Could not read the Lichess account (HTTP ${response.status}).`,
        response.status,
      );
    }
    const body = (await response.json()) as { id: string; username: string };
    return { id: body.id.toLowerCase(), username: body.username };
  }

  /**
   * Streams the user's finished standard games created after `since`, oldest
   * first, so an interrupted download can resume from the newest game saved.
   * Authenticated requests for the user's own games are served at 60 games per
   * second, the highest rate Lichess offers.
   */
  async *streamGames(
    username: string,
    token: string,
    since: number,
    signal?: AbortSignal,
  ): AsyncGenerator<LichessGameJson> {
    const params = new URLSearchParams({
      moves: 'true',
      opening: 'true',
      clocks: 'false',
      evals: 'false',
      sort: 'dateAsc',
      perfType: STANDARD_PERFS.join(','),
    });
    if (since > 0) params.set('since', String(since));
    const response = await fetch(`${API}/games/user/${encodeURIComponent(username)}?${params}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/x-ndjson' },
      signal,
    });
    if (!response.ok || !response.body) {
      const hint =
        response.status === 429 ? ' Lichess asks clients to wait a minute before retrying.' : '';
      throw new LichessApiError(
        `Lichess game export failed (HTTP ${response.status}).${hint}`,
        response.status,
      );
    }
    yield* parseNdjson<LichessGameJson>(response.body, signal);
  }
}
