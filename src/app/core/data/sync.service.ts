import { Injectable, computed, inject, signal } from '@angular/core';
import { Game } from '../../models/game';
import { LichessLink } from '../auth/user-profile.service';
import { LichessApiError, LichessApiService } from '../lichess/lichess-api.service';
import { parseLichessGame } from '../lichess/lichess-game';
import { GamesStoreService } from './games-store.service';
import { GamesRepoService } from './games-repo.service';
import { LocalDbService } from './local-db.service';

export type SyncPhase = 'idle' | 'pulling' | 'downloading' | 'uploading' | 'done' | 'error';

/** Games are written to IndexedDB in groups this size while streaming. */
const WRITE_CHUNK = 200;
/** How many pending games to push to Firestore per upload round. */
const UPLOAD_ROUND = 2000;

/**
 * Keeps the local store, Lichess and Firestore in step:
 *
 * 1. Pull from Firestore any games for this player newer than the last pull
 *    (covers games uploaded from another device or by an opponent).
 * 2. Stream from Lichess every game created after the newest one known, and
 *    save it locally flagged for upload.
 * 3. Upload pending games to Firestore in batches. Anything that fails
 *    (quota, offline) stays pending and is retried on the next sync.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly db = inject(LocalDbService);
  private readonly repo = inject(GamesRepoService);
  private readonly lichess = inject(LichessApiService);
  private readonly store = inject(GamesStoreService);

  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;

  readonly phase = signal<SyncPhase>('idle');
  readonly pulled = signal(0);
  readonly downloaded = signal(0);
  readonly uploaded = signal(0);
  readonly pending = signal(0);
  readonly error = signal<string | null>(null);
  /** Non-fatal problem from the last sync (for example the cloud pull failed). */
  readonly warning = signal<string | null>(null);
  readonly lastSyncAt = signal<number | null>(null);
  readonly busy = computed(() => ['pulling', 'downloading', 'uploading'].includes(this.phase()));

  /** Starts a sync unless one is already running. Safe to call repeatedly. */
  sync(link: LichessLink): Promise<void> {
    if (!this.running) {
      this.abort = new AbortController();
      this.running = this.run(link, this.abort.signal).finally(() => {
        this.running = null;
        this.abort = null;
      });
    }
    return this.running;
  }

  cancel(): void {
    this.abort?.abort();
  }

  private async run(link: LichessLink, signal: AbortSignal): Promise<void> {
    this.error.set(null);
    this.warning.set(null);
    this.pulled.set(0);
    this.downloaded.set(0);
    this.uploaded.set(0);
    try {
      await this.store.load(link.id);
      try {
        await this.pullFromFirestore(link.id);
      } catch (err) {
        // Games uploaded elsewhere are a convenience; Lichess remains the
        // source of truth, so carry on with the download and surface this.
        console.warn('pull from Firestore failed', err);
        this.warning.set(`Could not pull games from the cloud: ${this.describe(err)}`);
      }
      await this.downloadFromLichess(link, signal);
      await this.uploadPending();
      await this.store.refresh();
      this.lastSyncAt.set(Date.now());
      this.phase.set('done');
    } catch (err) {
      if (signal.aborted) {
        this.phase.set('idle');
        return;
      }
      console.error('sync failed', err);
      this.error.set(this.describe(err));
      this.phase.set('error');
      // Whatever was saved before the failure is still worth showing.
      await this.store.refresh();
    } finally {
      this.pending.set(await this.db.countPendingUploads());
    }
  }

  private async pullFromFirestore(lichessId: string): Promise<void> {
    this.phase.set('pulling');
    const key = `firestore:${lichessId}`;
    let cursor = await this.db.getCursor(key);
    for await (const page of this.repo.pullGames(lichessId, cursor)) {
      await this.db.putGames(page, 0);
      cursor = page[page.length - 1].createdAt;
      await this.db.setCursor(key, cursor);
      this.pulled.update((n) => n + page.length);
    }
  }

  private async downloadFromLichess(link: LichessLink, signal: AbortSignal): Promise<void> {
    this.phase.set('downloading');
    const key = `lichess:${link.id}`;
    const firestoreCursor = await this.db.getCursor(`firestore:${link.id}`);
    let cursor = Math.max(await this.db.getCursor(key), firestoreCursor);
    const since = cursor > 0 ? cursor + 1 : 0;
    let chunk: Game[] = [];
    const flush = async () => {
      if (chunk.length === 0) return;
      await this.db.putGames(chunk, 1);
      cursor = chunk[chunk.length - 1].createdAt;
      await this.db.setCursor(key, cursor);
      this.downloaded.update((n) => n + chunk.length);
      chunk = [];
    };
    let sinceRefresh = 0;
    for await (const raw of this.lichess.streamGames(link.username, link.token, since, signal)) {
      const game = parseLichessGame(raw);
      if (!game) continue;
      chunk.push(game);
      if (chunk.length >= WRITE_CHUNK) {
        await flush();
        sinceRefresh += WRITE_CHUNK;
        // Let the UI show progress on a long first import.
        if (sinceRefresh >= 1000) {
          sinceRefresh = 0;
          await this.store.refresh();
        }
      }
    }
    await flush();
  }

  private async uploadPending(): Promise<void> {
    this.phase.set('uploading');
    for (;;) {
      const pending = await this.db.pendingUploads(UPLOAD_ROUND);
      this.pending.set(await this.db.countPendingUploads());
      if (pending.length === 0) return;
      const games: Game[] = pending.map(({ pendingUpload: _flag, ...game }) => game);
      await this.repo.uploadGames(games, async (ids) => {
        await this.db.markUploaded(ids);
        this.uploaded.update((n) => n + ids.length);
        this.pending.update((n) => Math.max(0, n - ids.length));
      });
    }
  }

  private describe(err: unknown): string {
    if (err instanceof LichessApiError && err.isUnauthorized) {
      return 'Lichess no longer accepts the saved login. Reconnect your Lichess account.';
    }
    if (err instanceof Error) {
      if (/resource-exhausted/i.test(err.message)) {
        return 'Firestore daily quota reached. Remaining games will upload on a later sync.';
      }
      if (/failed-precondition/i.test(err.message) && /index/i.test(err.message)) {
        return 'the Firestore index for games is missing (deploy firestore.indexes.json).';
      }
      return err.message;
    }
    return String(err);
  }
}
