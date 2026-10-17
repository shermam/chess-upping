import { Injectable, inject, signal } from '@angular/core';
import { FirebaseService } from '../firebase/firebase.service';
import { Chess } from 'chess.js';
import {
  ENGINE_NAME,
  MAX_PV_MOVES,
  PositionEval,
  TERMINAL_DEPTH,
  positionFen,
  positionKey,
  toWhitePov,
} from '../../models/position-eval';
import { EnginePoolService, EvalPriority } from '../engine/engine-pool.service';
import { LocalDbService } from './local-db.service';
import { PositionsRepoService, isQuotaExceeded } from './positions-repo.service';

/** How long to stop uploading after Firestore reports the daily quota is spent. */
const QUOTA_BACKOFF_MS = 60 * 60 * 1000;
const UPLOAD_ROUND = 1000;

export type EvalSource = 'local' | 'cloud' | 'engine';

/**
 * The single entry point for position evaluations. Resolution order is the
 * local IndexedDB table, then the shared Firestore collection, then the
 * engine pool; whatever the engine computes is stored locally and queued for
 * upload. A position is never evaluated twice at the same depth, including
 * concurrently: in-flight requests are shared.
 */
@Injectable({ providedIn: 'root' })
export class EvalStoreService {
  private readonly db = inject(LocalDbService);
  private readonly repo = inject(PositionsRepoService);
  private readonly pool = inject(EnginePoolService);
  private readonly firebase = inject(FirebaseService);

  private readonly inflight = new Map<string, Promise<PositionEval>>();
  private uploading: Promise<void> | null = null;

  readonly pendingUploads = signal(0);
  readonly storedPositions = signal(0);
  /** Set while uploads are paused because the Firestore write quota ran out. */
  readonly uploadPausedUntil = signal<number | null>(null);
  readonly uploadError = signal<string | null>(null);

  async refreshCounts(): Promise<void> {
    this.pendingUploads.set(await this.db.countPendingPositionUploads());
    this.storedPositions.set(await this.db.countPositions());
  }

  /** Local-only lookup, no network and no engine. */
  async lookupLocal(fens: string[]): Promise<Map<string, PositionEval>> {
    const keys = fens.map(positionKey);
    const local = await this.db.getPositions(keys);
    return new Map([...local].map(([k, v]) => [k, stripLocal(v)]));
  }

  /**
   * Returns an evaluation of at least `depth` for every position, computing
   * the missing ones. `onResult` fires as each position resolves so a screen
   * can fill in progressively. The returned map is keyed by position key.
   */
  async getOrEvaluate(
    fens: string[],
    depth: number,
    priority: EvalPriority,
    options: {
      cloud?: boolean;
      onResult?: (e: PositionEval, source: EvalSource) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<Map<string, PositionEval>> {
    const cloud = options.cloud ?? true;
    const unique = new Map<string, string>();
    for (const fen of fens) unique.set(positionKey(fen), fen);
    const keys = [...unique.keys()];
    const results = new Map<string, PositionEval>();

    const local = await this.db.getPositions(keys);
    const missing: string[] = [];
    for (const key of keys) {
      const row = local.get(key);
      if (row && row.depth >= depth) {
        const e = stripLocal(row);
        results.set(key, e);
        options.onResult?.(e, 'local');
      } else missing.push(key);
    }

    if (cloud && missing.length > 0) {
      const fetched = await this.repo.fetchByKeys(missing).catch((err: unknown) => {
        console.warn('position lookup in Firestore failed', err);
        return new Map<string, PositionEval>();
      });
      const good = [...fetched.values()].filter((e) => e.depth >= depth);
      await this.db.putPositions([...fetched.values()], 0);
      for (const e of good) {
        results.set(e.key, e);
        options.onResult?.(e, 'cloud');
      }
    }

    const toCompute = missing.filter((k) => !results.has(k));
    // Feed the pool a few positions at a time so a cancelled job stops within
    // a couple of searches instead of after the whole game.
    const width = Math.max(2, this.pool.workers() * 2);
    let next = 0;
    const lane = async () => {
      while (next < toCompute.length) {
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const key = toCompute[next++];
        const e = await this.evaluateOne(key, unique.get(key)!, depth, priority);
        results.set(key, e);
        options.onResult?.(e, 'engine');
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, toCompute.length) }, lane));
    return results;
  }

  private evaluateOne(
    key: string,
    fen: string,
    depth: number,
    priority: EvalPriority,
  ): Promise<PositionEval> {
    const running = this.inflight.get(key);
    if (running) return running;
    const task = this.compute(key, fen, depth, priority).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  private async compute(
    key: string,
    fen: string,
    depth: number,
    priority: EvalPriority,
  ): Promise<PositionEval> {
    const terminal = terminalEval(key, fen);
    const e = terminal ?? (await this.search(key, fen, depth, priority));
    await this.db.putPositions([e], 1);
    this.pendingUploads.update((n) => n + 1);
    this.storedPositions.update((n) => n + 1);
    return e;
  }

  private async search(
    key: string,
    fen: string,
    depth: number,
    priority: EvalPriority,
  ): Promise<PositionEval> {
    const result = await this.pool.evaluate(fen, depth, priority);
    const info = result.info;
    if (!info) throw new Error(`Engine returned no evaluation for ${fen}`);
    const score = toWhitePov({ cp: info.cp, mate: info.mate }, fen);
    return {
      key,
      fen: positionFen(fen),
      cp: score.cp,
      mate: score.mate,
      depth: info.depth,
      bestMove: result.bestMove,
      pv: info.pv.slice(0, MAX_PV_MOVES).join(' '),
      engine: ENGINE_NAME,
      nodes: info.nodes,
      evaluatedAt: Date.now(),
    };
  }

  /** Pushes pending evaluations to Firestore; a quota error pauses uploads for a while. */
  uploadPending(): Promise<void> {
    if (!this.uploading) {
      this.uploading = this.runUpload().finally(() => (this.uploading = null));
    }
    return this.uploading;
  }

  private async runUpload(): Promise<void> {
    const pausedUntil = this.uploadPausedUntil();
    if (pausedUntil !== null && Date.now() < pausedUntil) return;
    // Nothing can be written without a signed-in user; keep the rows pending.
    if (!this.firebase.auth.currentUser) return;
    this.uploadPausedUntil.set(null);
    this.uploadError.set(null);
    try {
      for (;;) {
        const pending = await this.db.pendingPositionUploads(UPLOAD_ROUND);
        this.pendingUploads.set(await this.db.countPendingPositionUploads());
        if (pending.length === 0) return;
        let failed = 0;
        await this.repo.uploadEvals(pending.map(stripLocal), async (outcome) => {
          const done = [...outcome.uploaded, ...outcome.superseded];
          await this.db.markPositionsUploaded(done);
          this.pendingUploads.update((n) => Math.max(0, n - done.length));
          failed += outcome.failed.length;
        });
        if (failed > 0) {
          this.uploadError.set(
            `${failed} evaluation(s) were refused by the server and stay pending.`,
          );
          return;
        }
      }
    } catch (err) {
      if (isQuotaExceeded(err)) {
        this.uploadPausedUntil.set(Date.now() + QUOTA_BACKOFF_MS);
        this.uploadError.set('Firestore write quota reached; uploads resume in about an hour.');
      } else {
        console.warn('position upload failed', err);
        this.uploadError.set(err instanceof Error ? err.message : String(err));
      }
    }
  }
}

function stripLocal(e: PositionEval & { pendingUpload?: 0 | 1 }): PositionEval {
  const { pendingUpload: _flag, ...rest } = e;
  return rest;
}

/** Mate, stalemate and dead draws need no search. */
function terminalEval(key: string, fen: string): PositionEval | null {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  const base = {
    key,
    fen: positionFen(fen),
    depth: TERMINAL_DEPTH,
    bestMove: null,
    pv: '',
    engine: ENGINE_NAME,
    nodes: 0,
    evaluatedAt: Date.now(),
  };
  if (chess.isCheckmate()) return { ...base, cp: null, mate: 0 };
  if (chess.isStalemate() || chess.isInsufficientMaterial()) return { ...base, cp: 0, mate: null };
  return null;
}
