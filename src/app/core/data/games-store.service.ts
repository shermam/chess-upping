import { Injectable, inject, signal } from '@angular/core';
import { Game } from '../../models/game';
import { LocalDbService } from './local-db.service';

/**
 * In-memory view of the current user's games, loaded from IndexedDB. Every
 * screen reads from this signal, so navigating the opening tree never waits
 * on the network or the database.
 */
@Injectable({ providedIn: 'root' })
export class GamesStoreService {
  private readonly db = inject(LocalDbService);
  private loadedFor: string | null = null;

  readonly games = signal<Game[]>([]);
  readonly loading = signal(false);

  async load(lichessId: string): Promise<void> {
    this.loading.set(true);
    try {
      const games = await this.db.gamesForPlayer(lichessId);
      games.sort((a, b) => b.createdAt - a.createdAt);
      this.games.set(games);
      this.loadedFor = lichessId;
    } finally {
      this.loading.set(false);
    }
  }

  async refresh(): Promise<void> {
    if (this.loadedFor) await this.load(this.loadedFor);
  }

  reset(): void {
    this.loadedFor = null;
    this.games.set([]);
  }
}
