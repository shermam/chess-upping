import { Injectable, inject, signal } from '@angular/core';
import {
  GoogleAuthProvider,
  User,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import { FirebaseService } from '../firebase/firebase.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly firebase = inject(FirebaseService);

  /** `undefined` until Firebase has restored the session, then the user or null. */
  readonly user = signal<User | null | undefined>(undefined);

  constructor() {
    onAuthStateChanged(this.firebase.auth, (user) => this.user.set(user));
  }

  /** Resolves once the persisted session (if any) has been restored. */
  async ready(): Promise<User | null> {
    await this.firebase.auth.authStateReady();
    return this.firebase.auth.currentUser;
  }

  async signInWithGoogle(): Promise<void> {
    await signInWithPopup(this.firebase.auth, new GoogleAuthProvider());
  }

  async signOut(): Promise<void> {
    await signOut(this.firebase.auth);
  }
}
