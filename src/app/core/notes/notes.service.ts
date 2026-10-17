import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  Unsubscribe,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { AuthService } from '../auth/auth.service';
import { FirebaseService } from '../firebase/firebase.service';

export type NoteKind = 'position' | 'game';

export interface Note {
  id: string;
  kind: NoteKind;
  /** Position key or game id. */
  target: string;
  text: string;
  updatedAt: number;
}

/**
 * Private annotations, one document per position or game, under
 * `users/{uid}/notes`. Small enough to keep entirely in memory through a
 * live snapshot; writes go straight to Firestore (its offline queue covers a
 * flaky connection).
 */
@Injectable({ providedIn: 'root' })
export class NotesService {
  private readonly firebase = inject(FirebaseService);
  private readonly auth = inject(AuthService);
  private unsubscribe: Unsubscribe | null = null;

  readonly notes = signal<ReadonlyMap<string, Note>>(new Map());
  readonly loaded = signal(false);
  readonly count = computed(() => this.notes().size);

  constructor() {
    effect(() => {
      const uid = this.auth.user()?.uid ?? null;
      untracked(() => this.watch(uid));
    });
  }

  static noteId(kind: NoteKind, target: string): string {
    return `${kind === 'position' ? 'p' : 'g'}:${target}`;
  }

  get(kind: NoteKind, target: string): Note | null {
    return this.notes().get(NotesService.noteId(kind, target)) ?? null;
  }

  private watch(uid: string | null): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.notes.set(new Map());
    this.loaded.set(false);
    if (!uid) return;
    this.unsubscribe = onSnapshot(
      collection(this.firebase.firestore, 'users', uid, 'notes'),
      (snapshot) => {
        const map = new Map<string, Note>();
        for (const d of snapshot.docs) {
          const data = d.data() as Record<string, unknown>;
          const kind = data['kind'];
          const target = data['target'];
          const text = data['text'];
          if ((kind !== 'position' && kind !== 'game') || typeof target !== 'string') continue;
          if (typeof text !== 'string') continue;
          const updated = data['updatedAt'] as { toMillis(): number } | number | undefined;
          map.set(d.id, {
            id: d.id,
            kind,
            target,
            text,
            updatedAt: typeof updated === 'number' ? updated : (updated?.toMillis() ?? 0),
          });
        }
        this.notes.set(map);
        this.loaded.set(true);
      },
      (err) => console.error('notes snapshot failed', err),
    );
  }

  /** Saves the text; an empty text deletes the note. */
  async save(kind: NoteKind, target: string, text: string): Promise<void> {
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    const ref = doc(
      this.firebase.firestore,
      'users',
      uid,
      'notes',
      NotesService.noteId(kind, target),
    );
    const trimmed = text.trim();
    if (!trimmed) {
      await deleteDoc(ref);
      return;
    }
    await setDoc(ref, { kind, target, text: trimmed, updatedAt: serverTimestamp() });
  }
}
