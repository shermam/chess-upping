import { Injectable, inject } from '@angular/core';
import {
  Query,
  QueryDocumentSnapshot,
  QuerySnapshot,
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  writeBatch,
} from 'firebase/firestore';
import { Game } from '../../models/game';
import { FirebaseService } from '../firebase/firebase.service';

const PAGE_SIZE = 500;
/** Firestore allows 500 operations per batched write. */
const BATCH_SIZE = 500;

/** Access to the shared, public `games` collection in Firestore. */
@Injectable({ providedIn: 'root' })
export class GamesRepoService {
  private readonly firebase = inject(FirebaseService);

  private get games() {
    return collection(this.firebase.firestore, 'games');
  }

  /** Yields pages of games involving `lichessId` created after `since`, oldest first. */
  async *pullGames(lichessId: string, since: number): AsyncGenerator<Game[]> {
    let cursor: QueryDocumentSnapshot | null = null;
    for (;;) {
      const constraints = [
        where('players', 'array-contains', lichessId),
        where('createdAt', '>', since),
        orderBy('createdAt', 'asc'),
        limit(PAGE_SIZE),
      ];
      const q: Query = cursor
        ? query(this.games, ...constraints, startAfter(cursor))
        : query(this.games, ...constraints);
      const snapshot: QuerySnapshot = await getDocs(q);
      if (snapshot.empty) return;
      yield snapshot.docs.map((d) => d.data() as Game);
      if (snapshot.size < PAGE_SIZE) return;
      cursor = snapshot.docs[snapshot.docs.length - 1];
    }
  }

  /** Writes games in batches; `onBatch` receives the ids of each committed batch. */
  async uploadGames(games: Game[], onBatch: (ids: string[]) => Promise<void>): Promise<void> {
    for (let i = 0; i < games.length; i += BATCH_SIZE) {
      const chunk = games.slice(i, i + BATCH_SIZE);
      const batch = writeBatch(this.firebase.firestore);
      for (const game of chunk) batch.set(doc(this.games, game.id), game);
      await batch.commit();
      await onBatch(chunk.map((g) => g.id));
    }
  }
}
