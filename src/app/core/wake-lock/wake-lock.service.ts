import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { BulkEvalService } from '../data/bulk-eval.service';
import { EvalStoreService } from '../data/eval-store.service';
import { SyncService } from '../data/sync.service';

const SETTING_KEY = 'keep-awake';
/** After a refused request, try again this often while work is still running. */
const RETRY_MS = 30_000;

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

function loadSetting(): boolean {
  try {
    return localStorage.getItem(SETTING_KEY) !== 'off';
  } catch {
    return true;
  }
}

/**
 * Keeps the computer from going to sleep while the app is doing long work:
 * the engine evaluating games, games downloading from Lichess, or uploads
 * to Firestore. Uses the Screen Wake Lock API, which keeps the display on
 * and so, on most systems, the computer awake. The browser releases the
 * lock when the tab is hidden; it is requested again when the tab returns.
 */
@Injectable({ providedIn: 'root' })
export class WakeLockService {
  private readonly bulk = inject(BulkEvalService);
  private readonly sync = inject(SyncService);
  private readonly evals = inject(EvalStoreService);

  private sentinel: WakeLockSentinelLike | null = null;
  private requesting = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** User preference; on by default. */
  readonly enabled = signal(loadSetting());
  readonly supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  /** True while the lock is held. */
  readonly held = signal(false);
  readonly error = signal<string | null>(null);

  /** Whether any long-running work is in progress. */
  readonly working = computed(
    () =>
      this.bulk.phase() === 'running' ||
      this.bulk.phase() === 'stopping' ||
      this.sync.busy() ||
      this.evals.uploading(),
  );
  readonly wanted = computed(() => this.enabled() && this.working());

  constructor() {
    effect(() => {
      const enabled = this.enabled();
      try {
        localStorage.setItem(SETTING_KEY, enabled ? 'on' : 'off');
      } catch {
        // Ignore storage failures.
      }
    });
    effect(() => {
      const wanted = this.wanted();
      untracked(() => void (wanted ? this.acquire() : this.release()));
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.wanted()) void this.acquire();
      });
    }
  }

  private get api(): WakeLockLike | null {
    return this.supported ? (navigator as unknown as { wakeLock: WakeLockLike }).wakeLock : null;
  }

  private async acquire(): Promise<void> {
    const api = this.api;
    if (!api || this.requesting || (this.sentinel && !this.sentinel.released)) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    this.requesting = true;
    try {
      const sentinel = await api.request('screen');
      sentinel.addEventListener('release', () => {
        if (this.sentinel === sentinel) {
          this.sentinel = null;
          this.held.set(false);
        }
      });
      this.sentinel = sentinel;
      this.held.set(true);
      this.error.set(null);
      // The need may have gone away while the request was pending.
      if (!this.wanted()) await this.release();
    } catch (err) {
      // Typically NotAllowedError: low battery, a policy, or no visible document.
      this.error.set(err instanceof Error ? err.message : String(err));
      this.held.set(false);
      // The condition may clear (charger plugged in, tab visible again): keep trying
      // while the work is still running.
      this.scheduleRetry();
    } finally {
      this.requesting = false;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted() && !this.held()) void this.acquire();
    }, RETRY_MS);
  }

  private async release(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const sentinel = this.sentinel;
    this.sentinel = null;
    this.held.set(false);
    this.error.set(null);
    if (sentinel && !sentinel.released) {
      try {
        await sentinel.release();
      } catch {
        // Already released.
      }
    }
  }
}
