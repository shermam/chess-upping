import { Injectable } from '@angular/core';
import Dexie, { Table } from 'dexie';
import { Game, LocalGame } from '../../models/game';

interface MetaRow {
  key: string;
  value: number | string;
}

class ChessUppingDb extends Dexie {
  games!: Table<LocalGame, string>;
  meta!: Table<MetaRow, string>;

  constructor() {
    super('chess-upping');
    this.version(1).stores({
      games: 'id, createdAt, *players, pendingUpload',
      meta: 'key',
    });
  }
}

/**
 * Browser-side copy of everything the app works with. All reads for the UI
 * come from here, so interactions stay instant and Firestore is only touched
 * to sync. Cursors in `meta` remember how far each source has been read.
 */
@Injectable({ providedIn: 'root' })
export class LocalDbService {
  private readonly db = new ChessUppingDb();

  /** Inserts or replaces games. Existing rows keep their upload flag unless `pendingUpload` says otherwise. */
  async putGames(games: Game[], pendingUpload: 0 | 1): Promise<number> {
    if (games.length === 0) return 0;
    return this.db.transaction('rw', this.db.games, async () => {
      const existing = new Set(
        (await this.db.games
          .where('id')
          .anyOf(games.map((g) => g.id))
          .primaryKeys()) as string[],
      );
      const fresh = games.filter((g) => !existing.has(g.id));
      // A game already present locally was either pulled from Firestore or
      // uploaded before, so it never needs to go up again.
      await this.db.games.bulkPut(fresh.map((g) => ({ ...g, pendingUpload })));
      return fresh.length;
    });
  }

  gamesForPlayer(lichessId: string): Promise<LocalGame[]> {
    return this.db.games.where('players').equals(lichessId).toArray();
  }

  countForPlayer(lichessId: string): Promise<number> {
    return this.db.games.where('players').equals(lichessId).count();
  }

  pendingUploads(limit: number): Promise<LocalGame[]> {
    return this.db.games.where('pendingUpload').equals(1).limit(limit).toArray();
  }

  countPendingUploads(): Promise<number> {
    return this.db.games.where('pendingUpload').equals(1).count();
  }

  async markUploaded(ids: string[]): Promise<void> {
    await this.db.games.where('id').anyOf(ids).modify({ pendingUpload: 0 });
  }

  async getCursor(key: string): Promise<number> {
    const row = await this.db.meta.get(key);
    return typeof row?.value === 'number' ? row.value : 0;
  }

  async setCursor(key: string, value: number): Promise<void> {
    await this.db.meta.put({ key, value });
  }

  /** Wipes the local store (used when the user signs out or unlinks Lichess). */
  async clear(): Promise<void> {
    await this.db.transaction('rw', this.db.games, this.db.meta, async () => {
      await this.db.games.clear();
      await this.db.meta.clear();
    });
  }
}
