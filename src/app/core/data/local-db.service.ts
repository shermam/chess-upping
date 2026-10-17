import { Injectable } from '@angular/core';
import Dexie, { Table } from 'dexie';
import { Game, LocalGame } from '../../models/game';
import { GameEvalRecord, LocalPositionEval, PositionEval } from '../../models/position-eval';

interface MetaRow {
  key: string;
  value: number | string;
}

class ChessUppingDb extends Dexie {
  games!: Table<LocalGame, string>;
  meta!: Table<MetaRow, string>;
  positions!: Table<LocalPositionEval, string>;
  gameEvals!: Table<GameEvalRecord, string>;

  constructor() {
    super('chess-upping');
    this.version(1).stores({
      games: 'id, createdAt, *players, pendingUpload',
      meta: 'key',
    });
    this.version(2).stores({
      games: 'id, createdAt, *players, pendingUpload',
      meta: 'key',
      positions: 'key, depth, pendingUpload',
      gameEvals: 'gameId, depth',
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

  /**
   * Adds clock data to games already stored without it and flags them for
   * upload. Games not stored yet are inserted. Returns how many rows changed.
   */
  async mergeClocks(games: Game[]): Promise<number> {
    if (games.length === 0) return 0;
    return this.db.transaction('rw', this.db.games, async () => {
      const existing = await this.db.games.bulkGet(games.map((g) => g.id));
      const updates: LocalGame[] = [];
      const inserts: LocalGame[] = [];
      games.forEach((g, i) => {
        const row = existing[i];
        if (!row) inserts.push({ ...g, pendingUpload: 1 });
        else if (row.clocks == null && g.clocks !== null) {
          // Rows written before clocks were collected have no property at all.
          updates.push({ ...row, clocks: g.clocks, pendingUpload: 1 });
        }
      });
      await this.db.games.bulkPut([...inserts, ...updates]);
      return inserts.length + updates.length;
    });
  }

  getGame(id: string): Promise<LocalGame | undefined> {
    return this.db.games.get(id);
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

  // ---- Engine evaluations -------------------------------------------------

  async getPositions(keys: string[]): Promise<Map<string, LocalPositionEval>> {
    const rows = await this.db.positions.bulkGet(keys);
    const map = new Map<string, LocalPositionEval>();
    rows.forEach((row) => {
      if (row) map.set(row.key, row);
    });
    return map;
  }

  /**
   * Stores evaluations, keeping whichever is deeper when one already exists.
   * Returns the evaluations that were actually written.
   */
  async putPositions(evals: PositionEval[], pendingUpload: 0 | 1): Promise<PositionEval[]> {
    if (evals.length === 0) return [];
    return this.db.transaction('rw', this.db.positions, async () => {
      const existing = await this.getPositions(evals.map((e) => e.key));
      const fresh = evals.filter((e) => (existing.get(e.key)?.depth ?? -1) < e.depth);
      await this.db.positions.bulkPut(fresh.map((e) => ({ ...e, pendingUpload })));
      return fresh;
    });
  }

  pendingPositionUploads(limit: number): Promise<LocalPositionEval[]> {
    return this.db.positions.where('pendingUpload').equals(1).limit(limit).toArray();
  }

  countPendingPositionUploads(): Promise<number> {
    return this.db.positions.where('pendingUpload').equals(1).count();
  }

  countPositions(): Promise<number> {
    return this.db.positions.count();
  }

  async markPositionsUploaded(keys: string[]): Promise<void> {
    await this.db.positions.where('key').anyOf(keys).modify({ pendingUpload: 0 });
  }

  getGameEval(gameId: string): Promise<GameEvalRecord | undefined> {
    return this.db.gameEvals.get(gameId);
  }

  async gameEvalDepths(): Promise<Map<string, number>> {
    const rows = await this.db.gameEvals.toArray();
    return new Map(rows.map((r) => [r.gameId, r.depth]));
  }

  async setGameEval(record: GameEvalRecord): Promise<void> {
    await this.db.gameEvals.put(record);
  }

  /** Wipes the local store (used when the user signs out or unlinks Lichess). */
  async clear(): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.games, this.db.meta, this.db.positions, this.db.gameEvals],
      async () => {
        await this.db.games.clear();
        await this.db.meta.clear();
        await this.db.positions.clear();
        await this.db.gameEvals.clear();
      },
    );
  }
}
