import { Injectable, computed, inject, signal } from '@angular/core';
import { Chess } from 'chess.js';
import { Game } from '../../models/game';
import { positionKey } from '../../models/position-eval';
import { LocalDbService } from './local-db.service';

/** Games processed per slice before yielding to the browser. */
const SLICE = 40;
/**
 * Plies kept in the index. The explorer is about openings, and keeping only
 * the first 30 moves bounds memory to a few KB per game.
 */
export const MAX_INDEX_PLIES = 60;

/**
 * Position keys reached by a game: index 0 is the start position, index p the
 * position after p plies, up to `maxPlies` plies.
 */
export function gameKeys(game: Game, maxPlies = Infinity): string[] {
  const chess = new Chess();
  const keys = [positionKey(chess.fen())];
  for (const san of game.moves.split(' ')) {
    if (keys.length > maxPlies) break;
    try {
      chess.move(san);
    } catch {
      break;
    }
    keys.push(positionKey(chess.fen()));
  }
  return keys;
}

/**
 * Position keys for every game, so the opening tree can merge transpositions
 * (group games by the position reached rather than by move order). Keys are
 * computed once per game, in slices that keep the UI responsive, and kept in
 * IndexedDB so the next visit starts instantly.
 */
@Injectable({ providedIn: 'root' })
export class PositionIndexService {
  private readonly db = inject(LocalDbService);
  private readonly keysByGame = new Map<string, string[]>();
  private building: Promise<void> | null = null;
  /** The newest list requested while a build was running; built right after. */
  private pending: readonly Game[] | null = null;
  /** Bumped by `reset()` so a build in flight stops touching the new state. */
  private generation = 0;

  readonly indexed = signal(0);
  readonly total = signal(0);
  readonly ready = computed(() => this.total() > 0 && this.indexed() >= this.total());
  /** Bumps whenever new keys become available, so computed views can refresh. */
  readonly version = signal(0);

  keysFor(gameId: string): string[] | undefined {
    return this.keysByGame.get(gameId);
  }

  /**
   * Makes sure every game in the list has keys, computing the missing ones in
   * the background. A list that arrives while a build is running (the sync
   * refreshing the store) is built right after it, so nothing is skipped.
   */
  ensure(games: readonly Game[]): Promise<void> {
    if (this.building) {
      this.pending = games;
      return this.building;
    }
    this.building = (async () => {
      let next: readonly Game[] | null = games;
      while (next) {
        const list = next;
        this.pending = null;
        await this.build(list, this.generation);
        next = this.pending;
      }
    })().finally(() => (this.building = null));
    return this.building;
  }

  private async build(games: readonly Game[], generation: number): Promise<void> {
    this.total.set(games.length);
    const missing = games.filter((g) => !this.keysByGame.has(g.id));
    this.indexed.set(games.length - missing.length);
    if (missing.length === 0) return;

    const stored = await this.db.getGameKeys(missing.map((g) => g.id));
    if (generation !== this.generation) return;
    const toCompute: Game[] = [];
    for (const g of missing) {
      const keys = stored.get(g.id);
      if (keys) this.keysByGame.set(g.id, keys);
      else toCompute.push(g);
    }
    this.indexed.set(games.length - toCompute.length);
    this.version.update((v) => v + 1);

    for (let i = 0; i < toCompute.length; i += SLICE) {
      const slice = toCompute.slice(i, i + SLICE);
      const computed = slice.map((g) => ({ gameId: g.id, keys: gameKeys(g, MAX_INDEX_PLIES) }));
      if (generation !== this.generation) return;
      for (const c of computed) this.keysByGame.set(c.gameId, c.keys);
      await this.db.putGameKeys(computed);
      if (generation !== this.generation) return;
      this.indexed.update((n) => n + slice.length);
      this.version.update((v) => v + 1);
      // Yield so rendering and input stay smooth during a long first build.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  /** Forgets everything; a build in flight stops at its next step. */
  reset(): void {
    this.generation++;
    this.pending = null;
    this.keysByGame.clear();
    this.indexed.set(0);
    this.total.set(0);
    this.version.update((v) => v + 1);
  }
}
