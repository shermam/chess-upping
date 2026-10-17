import { Injectable, signal } from '@angular/core';
import { FirebaseApp, FirebaseOptions, initializeApp } from 'firebase/app';
import { Auth, connectAuthEmulator, getAuth } from 'firebase/auth';
import {
  Firestore,
  connectFirestoreEmulator,
  initializeFirestore,
  memoryLocalCache,
} from 'firebase/firestore';

/**
 * Reserved Firebase Hosting endpoint that returns the web app config for the
 * project serving the current origin. Hosting generates it, so no config has
 * to live in the repository. During `ng serve` the dev-server proxy
 * (`proxy.conf.json`) forwards this path to the production Hosting site.
 */
const RUNTIME_CONFIG_URL = '/__/firebase/init.json';
const RUNTIME_CONFIG_TIMEOUT_MS = 10_000;

/**
 * Address of the Firebase Emulator Hub started by `firebase emulators:start`.
 * When the app runs on localhost and the hub answers, Auth and Firestore are
 * pointed at the emulators it lists, so local development needs no build-time
 * configuration.
 */
const EMULATOR_HUB_URL = 'http://127.0.0.1:4400/emulators';
const EMULATOR_HUB_TIMEOUT_MS = 1_000;

interface EmulatorHubInfo {
  auth?: { host: string; port: number };
  firestore?: { host: string; port: number };
}

function onLocalhost(): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

async function discoverEmulators(): Promise<EmulatorHubInfo | null> {
  if (!onLocalhost()) return null;
  try {
    const response = await fetch(EMULATOR_HUB_URL, {
      signal: AbortSignal.timeout(EMULATOR_HUB_TIMEOUT_MS),
    });
    return response.ok ? ((await response.json()) as EmulatorHubInfo) : null;
  } catch {
    return null;
  }
}

@Injectable({ providedIn: 'root' })
export class FirebaseService {
  private app?: FirebaseApp;
  private authInstance?: Auth;
  private firestoreInstance?: Firestore;

  /** Set when initialisation failed; the shell shows it instead of the app. */
  readonly initError = signal<string | null>(null);
  /** True when Auth/Firestore were connected to local emulators. */
  readonly usingEmulators = signal(false);

  async init(): Promise<void> {
    try {
      const response = await fetch(RUNTIME_CONFIG_URL, {
        signal: AbortSignal.timeout(RUNTIME_CONFIG_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`${RUNTIME_CONFIG_URL} returned HTTP ${response.status}`);
      }
      const options = (await response.json()) as FirebaseOptions;
      this.app = initializeApp(options);
      this.authInstance = getAuth(this.app);
      // The app keeps its own IndexedDB copy of the data it needs, so the
      // Firestore SDK cache stays in memory to avoid storing everything twice.
      this.firestoreInstance = initializeFirestore(this.app, {
        localCache: memoryLocalCache(),
      });
      const emulators = await discoverEmulators();
      if (emulators?.auth) {
        const { host, port } = emulators.auth;
        connectAuthEmulator(this.authInstance, `http://${host}:${port}`, { disableWarnings: true });
        this.usingEmulators.set(true);
      }
      if (emulators?.firestore) {
        const { host, port } = emulators.firestore;
        connectFirestoreEmulator(this.firestoreInstance, host, port);
        this.usingEmulators.set(true);
      }
    } catch (err) {
      this.initError.set(err instanceof Error ? err.message : String(err));
    }
  }

  get auth(): Auth {
    if (!this.authInstance) throw new Error('Firebase is not initialised');
    return this.authInstance;
  }

  get firestore(): Firestore {
    if (!this.firestoreInstance) throw new Error('Firebase is not initialised');
    return this.firestoreInstance;
  }
}
