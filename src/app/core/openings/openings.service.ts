import { Injectable, signal } from '@angular/core';

export interface OpeningInfo {
  eco: string;
  name: string;
  /** Number of plies of the reference line that reaches this position. */
  ply: number;
}

interface RawEntry {
  k: string;
  e: string;
  n: string;
  p: number;
}

/**
 * ECO opening names keyed by position (the same key as engine evaluations),
 * generated from the lichess-org/chess-openings dataset by
 * `scripts/build-openings.mjs`. Being keyed by position rather than by move
 * order, it names transpositions correctly.
 */
@Injectable({ providedIn: 'root' })
export class OpeningsService {
  private map: Map<string, OpeningInfo> | null = null;
  private loading: Promise<void> | null = null;

  readonly ready = signal(false);

  load(): Promise<void> {
    if (!this.loading) {
      this.loading = fetch('/openings.json')
        .then((r) => {
          if (!r.ok) throw new Error(`openings.json: HTTP ${r.status}`);
          return r.json() as Promise<RawEntry[]>;
        })
        .then((entries) => {
          this.map = new Map(entries.map((e) => [e.k, { eco: e.e, name: e.n, ply: e.p }]));
          this.ready.set(true);
        })
        .catch((err: unknown) => {
          console.warn('could not load opening names', err);
          this.loading = null;
        });
    }
    return this.loading;
  }

  lookup(key: string): OpeningInfo | null {
    return this.map?.get(key) ?? null;
  }

  /** The deepest named position along a sequence of position keys. */
  nameForKeys(keys: readonly string[]): OpeningInfo | null {
    if (!this.map) return null;
    for (let i = keys.length - 1; i >= 0; i--) {
      const hit = this.map.get(keys[i]);
      if (hit) return hit;
    }
    return null;
  }
}
