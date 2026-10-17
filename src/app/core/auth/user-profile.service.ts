import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import {
  Unsubscribe,
  deleteField,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { FirebaseService } from '../firebase/firebase.service';
import { AuthService } from './auth.service';

/** Link between a Google account and a Lichess account, stored on the user doc. */
export interface LichessLink {
  /** Lowercase Lichess user id. Games are matched on this. */
  id: string;
  /** Display username as Lichess shows it. */
  username: string;
  /** OAuth access token. Readable only by the owning user (see firestore.rules). */
  token: string;
  linkedAt: number;
}

export interface UserProfile {
  email: string | null;
  displayName: string | null;
  lichess?: LichessLink;
}

@Injectable({ providedIn: 'root' })
export class UserProfileService {
  private readonly firebase = inject(FirebaseService);
  private readonly auth = inject(AuthService);
  private unsubscribe: Unsubscribe | null = null;

  /** `undefined` while loading, null when signed out or no profile doc yet. */
  readonly profile = signal<UserProfile | null | undefined>(undefined);

  constructor() {
    effect(() => {
      const user = this.auth.user();
      untracked(() => this.watch(user?.uid ?? null));
    });
  }

  private watch(uid: string | null): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (!uid) {
      this.profile.set(null);
      return;
    }
    this.profile.set(undefined);
    this.unsubscribe = onSnapshot(
      doc(this.firebase.firestore, 'users', uid),
      (snapshot) => this.profile.set(snapshot.exists() ? (snapshot.data() as UserProfile) : null),
      (err) => {
        console.error('profile snapshot failed', err);
        this.profile.set(null);
      },
    );
  }

  private uid(): string {
    const user = this.auth.user();
    if (!user) throw new Error('Not signed in');
    return user.uid;
  }

  async linkLichess(link: LichessLink): Promise<void> {
    const user = this.auth.user();
    await setDoc(
      doc(this.firebase.firestore, 'users', this.uid()),
      {
        email: user?.email ?? null,
        displayName: user?.displayName ?? null,
        lichess: link,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  }

  async unlinkLichess(): Promise<void> {
    await setDoc(
      doc(this.firebase.firestore, 'users', this.uid()),
      { lichess: deleteField(), updatedAt: serverTimestamp() },
      { merge: true },
    );
  }
}
