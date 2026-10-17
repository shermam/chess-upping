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
 * The Lichess export filters on creation time and leaves out games still in
 * progress, so a game created before the cursor but finished after it would
 * be missed. Re-requesting this much history each time catches games that
 * finished within the window; the local store de-duplicates the rest.
 */
const LICHESS_OVERLAP_MS = 14 * 24 * 60 * 60 * 1000;

/** The Lichess `since` value to request given the newest game already downloaded. */
export function lichessSince(cursor: number, now: number): number {
  if (cursor <= 0) return 0;
  return Math.max(1, Math.min(cursor + 1, now - LICHESS_OVERLAP_MS));
}

/**
 * Keeps the local store, Lichess and Firestore in step:
 *
 * 1. Pull from Firestore any games for this player uploaded since the last
 *    pull (covers games uploaded from another device or by an opponent).
 * 2. Stream from Lichess every game created after the newest one this device
 *    downloaded before (with an overlap window), and save it locally flagged
 *    for upload.
 * 3. Upload pending games to Firestore in batches. Anything that fails
 *    (quota, offline) stays pending and is retried on the next sync.
 *
 * The two cursors are independent on purpose: what someone else uploaded
 * says nothing about which games this user still has to fetch from Lichess.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly db = inject(LocalDbService);
  private readonly repo = inject(GamesRepoService);
  private readonly lichess = inject(LichessApiService);
  private readonly store = inject(GamesStoreService);

  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;
  /** A link that changed while a sync was running; synced right after. */
  private queued: LichessLink | null = null;

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
    if (this.running) {
      if (this.current?.token !== link.token) this.queued = link;
      return this.running;
    }
    this.current = link;
    this.abort = new AbortController();
    this.running = this.run(link, this.abort.signal).finally(() => {
      this.running = null;
      this.abort = null;
      this.current = null;
      const next = this.queued;
      this.queued = null;
      if (next) void this.sync(next);
    });
    return this.running;
  }

  private current: LichessLink | null = null;

  /** Stops the running sync (if any) and resolves once it has fully stopped. */
  async cancel(): Promise<void> {
    this.queued = null;
    this.abort?.abort();
    await this.running?.catch(() => undefined);
  }

  private async run(link: LichessLink, signal: AbortSignal): Promise<void> {
    this.error.set(null);
    this.warning.set(null);
    this.pulled.set(0);
    this.downloaded.set(0);
    this.uploaded.set(0);
    const warnings: string[] = [];
    try {
      await this.store.load(link.id);
      try {
        await this.pullFromFirestore(link.id, warnings);
      } catch (err) {
        // Games uploaded elsewhere are a convenience; Lichess remains the
        // source of truth, so carry on with the download and surface this.
        console.warn('pull from Firestore failed', err);
        warnings.push(`Could not pull games from the cloud: ${this.describe(err)}`);
      }
      this.throwIfAborted(signal);
      await this.backfillClocks(link, signal);
      this.throwIfAborted(signal);
      await this.downloadFromLichess(link, signal);
      this.throwIfAborted(signal);
      await this.uploadPending(warnings);
      await this.store.refresh();
      this.lastSyncAt.set(Date.now());
      this.warning.set(warnings.length > 0 ? warnings.join(' ') : null);
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
      if (!signal.aborted) this.pending.set(await this.db.countPendingUploads());
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  }

  private async pullFromFirestore(lichessId: string, warnings: string[]): Promise<void> {
    this.phase.set('pulling');
    const key = `firestore:${lichessId}`;
    let skipped = 0;
    for await (const page of this.repo.pullGames(lichessId, await this.db.getCursor(key))) {
      await this.db.putGames(page.games, 0);
      await this.db.setCursor(key, page.cursor);
      this.pulled.update((n) => n + page.games.length);
      skipped += page.skipped;
    }
    if (skipped > 0) warnings.push(`Ignored ${skipped} malformed cloud game(s).`);
  }

  /**
   * Games imported before move times were collected lack clock data. Once per
   * account, re-stream the whole history (fast: 60 games/s) and add the
   * clocks to the stored games; a device whose first sync already included
   * clocks has nothing to do.
   */
  private async backfillClocks(link: LichessLink, signal: AbortSignal): Promise<void> {
    const flagKey = `clocksBackfill:${link.id}`;
    if ((await this.db.getCursor(flagKey)) > 0) return;
    const downloadedBefore = (await this.db.getCursor(`lichess:${link.id}`)) > 0;
    const pulledBefore = (await this.db.getCursor(`firestore:${link.id}`)) > 0;
    if (downloadedBefore || pulledBefore) {
      this.phase.set('downloading');
      let chunk: Game[] = [];
      const flush = async () => {
        if (chunk.length === 0) return;
        this.throwIfAborted(signal);
        await this.db.mergeClocks(chunk);
        this.downloaded.update((n) => n + chunk.length);
        chunk = [];
      };
      for await (const raw of this.lichess.streamGames(link.username, link.token, 0, signal)) {
        const game = parseLichessGame(raw);
        if (!game || !game.clocks) continue;
        chunk.push(game);
        if (chunk.length >= WRITE_CHUNK) await flush();
      }
      await flush();
    }
    await this.db.setCursor(flagKey, Date.now());
  }

  private async downloadFromLichess(link: LichessLink, signal: AbortSignal): Promise<void> {
    this.phase.set('downloading');
    const key = `lichess:${link.id}`;
    const since = lichessSince(await this.db.getCursor(key), Date.now());
    let chunk: Game[] = [];
    const flush = async () => {
      if (chunk.length === 0) return;
      // Never write into a store that is being cleared by sign-out/unlink.
      this.throwIfAborted(signal);
      await this.db.putGames(chunk, 1);
      await this.db.setCursor(key, chunk[chunk.length - 1].createdAt);
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

  private async uploadPending(warnings: string[]): Promise<void> {
    this.phase.set('uploading');
    let rejected = 0;
    for (;;) {
      const pending = await this.db.pendingUploads(UPLOAD_ROUND);
      this.pending.set(await this.db.countPendingUploads());
      if (pending.length === 0) break;
      const games: Game[] = pending.map(({ pendingUpload: _flag, ...game }) => game);
      await this.repo.uploadGames(games, async (outcome) => {
        // Rejected games already exist in the cloud (or can never be
        // accepted), so they must not stay pending and block the queue.
        const done = [...outcome.uploaded, ...outcome.rejected];
        await this.db.markUploaded(done);
        rejected += outcome.rejected.length;
        this.uploaded.update((n) => n + outcome.uploaded.length);
        this.pending.update((n) => Math.max(0, n - done.length));
      });
    }
    if (rejected > 0) warnings.push(`${rejected} game(s) were already in the cloud.`);
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
