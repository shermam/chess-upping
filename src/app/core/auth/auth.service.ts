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
    // When Firebase failed to initialise the shell shows the error instead of
    // the app; touching Auth here would throw and abort bootstrap entirely.
    if (this.firebase.initError()) {
      this.user.set(null);
      return;
    }
    onAuthStateChanged(this.firebase.auth, (user) => this.user.set(user));
  }

  /** Resolves once the persisted session (if any) has been restored. */
  async ready(): Promise<User | null> {
    if (this.firebase.initError()) return null;
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
