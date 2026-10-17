import { Injectable, inject } from '@angular/core';
import {
  FirestoreError,
  Query,
  QueryDocumentSnapshot,
  QuerySnapshot,
  Timestamp,
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { Game } from '../../models/game';
import { toGame } from '../../models/game-validation';
import { FirebaseService } from '../firebase/firebase.service';

const PAGE_SIZE = 500;
/** Firestore allows 500 operations per batched write. */
const BATCH_SIZE = 500;

export interface PulledPage {
  games: Game[];
  /** Upload time of the last document in the page, in milliseconds; the next cursor. */
  cursor: number;
  /** Documents skipped because they did not have the expected shape. */
  skipped: number;
}

export interface UploadOutcome {
  /** Ids written by this call. */
  uploaded: string[];
  /** Ids the server refused, usually because another player already uploaded them. */
  rejected: string[];
}

/** Access to the shared, public `games` collection in Firestore. */
@Injectable({ providedIn: 'root' })
export class GamesRepoService {
  private readonly firebase = inject(FirebaseService);

  private get games() {
    return collection(this.firebase.firestore, 'games');
  }

  /**
   * Yields pages of games involving `lichessId` uploaded after `since`
   * (milliseconds), oldest upload first. Paging on the server-side upload time
   * rather than on the game date means documents that arrive out of date
   * order (partial uploads, an opponent's sync) are never missed.
   */
  async *pullGames(lichessId: string, since: number): AsyncGenerator<PulledPage> {
    let cursor: QueryDocumentSnapshot | null = null;
    for (;;) {
      const constraints = [
        where('players', 'array-contains', lichessId),
        where('uploadedAt', '>', Timestamp.fromMillis(since)),
        orderBy('uploadedAt', 'asc'),
        limit(PAGE_SIZE),
      ];
      const q: Query = cursor
        ? query(this.games, ...constraints, startAfter(cursor))
        : query(this.games, ...constraints);
      const snapshot: QuerySnapshot = await getDocs(q);
      if (snapshot.empty) return;
      const games: Game[] = [];
      let skipped = 0;
      for (const d of snapshot.docs) {
        const game = toGame(d.data());
        if (game) games.push(game);
        else skipped++;
      }
      const last = snapshot.docs[snapshot.docs.length - 1];
      const uploadedAt = last.get('uploadedAt') as Timestamp | undefined;
      yield { games, cursor: uploadedAt?.toMillis() ?? since, skipped };
      if (snapshot.size < PAGE_SIZE) return;
      cursor = last;
    }
  }

  /**
   * Writes games in batches of up to 500. A batch is all-or-nothing, so when
   * one is refused (typically because a game in it already exists, uploaded by
   * the opponent) the games are retried one by one and the refused ones are
   * reported instead of blocking the rest. `onChunk` runs after each chunk so
   * progress survives an interruption.
   */
  async uploadGames(
    games: Game[],
    onChunk: (outcome: UploadOutcome) => Promise<void>,
  ): Promise<void> {
    for (let i = 0; i < games.length; i += BATCH_SIZE) {
      const chunk = games.slice(i, i + BATCH_SIZE);
      const outcome = await this.uploadChunk(chunk);
      await onChunk(outcome);
    }
  }

  private async addClocks(game: Game): Promise<boolean> {
    try {
      await updateDoc(doc(this.games, game.id), {
        clocks: game.clocks,
        uploadedBy: this.firebase.auth.currentUser?.uid ?? null,
        uploadedAt: serverTimestamp(),
      });
      return true;
    } catch (err) {
      if (!isPermissionDenied(err)) throw err;
      return false;
    }
  }

  private uploadDoc(game: Game) {
    return {
      ...game,
      uploadedBy: this.firebase.auth.currentUser?.uid ?? null,
      uploadedAt: serverTimestamp(),
    };
  }

  private async uploadChunk(chunk: Game[]): Promise<UploadOutcome> {
    const batch = writeBatch(this.firebase.firestore);
    for (const game of chunk) batch.set(doc(this.games, game.id), this.uploadDoc(game));
    try {
      await batch.commit();
      return { uploaded: chunk.map((g) => g.id), rejected: [] };
    } catch (err) {
      if (!isPermissionDenied(err)) throw err;
    }
    const outcome: UploadOutcome = { uploaded: [], rejected: [] };
    for (const game of chunk) {
      try {
        await setDoc(doc(this.games, game.id), this.uploadDoc(game));
        outcome.uploaded.push(game.id);
      } catch (err) {
        if (!isPermissionDenied(err)) throw err;
        // The document exists. The rules still allow adding clock data to a
        // document that has none, which is how older uploads are completed.
        if (game.clocks && (await this.addClocks(game))) outcome.uploaded.push(game.id);
        else outcome.rejected.push(game.id);
      }
    }
    return outcome;
  }
}

function isPermissionDenied(err: unknown): boolean {
  return (err as FirestoreError | undefined)?.code === 'permission-denied';
}
