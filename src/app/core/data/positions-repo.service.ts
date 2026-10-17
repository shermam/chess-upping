import { Injectable, inject } from '@angular/core';
import {
  FirestoreError,
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { PositionEval } from '../../models/position-eval';
import { FirebaseService } from '../firebase/firebase.service';
export interface EvalUploadOutcome {
  /** Keys written by this call. */
  uploaded: string[];
  /** Keys the cloud already holds at the same or a deeper depth. */
  superseded: string[];
  /** Keys refused for another reason; they stay pending for a later attempt. */
  failed: string[];
}

/** Firestore allows at most 30 values in an `in` filter. */
const IN_LIMIT = 30;
const BATCH_SIZE = 500;

function isValidEval(x: unknown): x is PositionEval {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  return (
    typeof e['key'] === 'string' &&
    typeof e['fen'] === 'string' &&
    (e['cp'] === null || num(e['cp'])) &&
    (e['mate'] === null || num(e['mate'])) &&
    (e['cp'] !== null || e['mate'] !== null) &&
    num(e['depth']) &&
    (e['bestMove'] === null || typeof e['bestMove'] === 'string') &&
    typeof e['pv'] === 'string' &&
    typeof e['engine'] === 'string' &&
    num(e['nodes']) &&
    num(e['evaluatedAt'])
  );
}

function toEval(x: unknown): PositionEval | null {
  if (!isValidEval(x)) return null;
  const { key, fen, cp, mate, depth, bestMove, pv, engine, nodes, evaluatedAt } = x;
  return { key, fen, cp, mate, depth, bestMove, pv, engine, nodes, evaluatedAt };
}

/**
 * Shared `positions` collection: one document per position, replaced only by
 * a deeper evaluation. Lookups are by document id in chunks of 30, which
 * costs about one read per chunk when nothing is found, so checking a whole
 * game against the cloud is cheap.
 */
@Injectable({ providedIn: 'root' })
export class PositionsRepoService {
  private readonly firebase = inject(FirebaseService);

  private get positions() {
    return collection(this.firebase.firestore, 'positions');
  }

  async fetchByKeys(keys: string[]): Promise<Map<string, PositionEval>> {
    const found = new Map<string, PositionEval>();
    for (let i = 0; i < keys.length; i += IN_LIMIT) {
      const chunk = keys.slice(i, i + IN_LIMIT);
      const snapshot = await getDocs(query(this.positions, where(documentId(), 'in', chunk)));
      for (const d of snapshot.docs) {
        const e = toEval(d.data());
        if (e) found.set(e.key, e);
      }
    }
    return found;
  }

  private uploadDoc(e: PositionEval) {
    return {
      ...e,
      uploadedBy: this.firebase.auth.currentUser?.uid ?? null,
      uploadedAt: serverTimestamp(),
    };
  }

  /**
   * Writes evaluations in batches. The rules refuse a document that is not
   * deeper than the stored one, which fails the whole batch, so a refused
   * batch is retried one document at a time and refusals are reported.
   */
  async uploadEvals(
    evals: PositionEval[],
    onChunk: (o: EvalUploadOutcome) => Promise<void>,
  ): Promise<void> {
    for (let i = 0; i < evals.length; i += BATCH_SIZE) {
      const chunk = evals.slice(i, i + BATCH_SIZE);
      const batch = writeBatch(this.firebase.firestore);
      for (const e of chunk) batch.set(doc(this.positions, e.key), this.uploadDoc(e));
      let outcome: EvalUploadOutcome;
      try {
        await batch.commit();
        outcome = { uploaded: chunk.map((e) => e.key), superseded: [], failed: [] };
      } catch (err) {
        if (!isPermissionDenied(err)) throw err;
        outcome = { uploaded: [], superseded: [], failed: [] };
        for (const e of chunk) {
          try {
            await setDoc(doc(this.positions, e.key), this.uploadDoc(e));
            outcome.uploaded.push(e.key);
          } catch (inner) {
            if (!isPermissionDenied(inner)) throw inner;
            // Superseded only when the cloud really holds a deeper (or equal)
            // record; anything else stays pending for a later attempt.
            const existing = await getDoc(doc(this.positions, e.key));
            const cloudDepth = (existing.data()?.['depth'] as number | undefined) ?? -1;
            if (cloudDepth >= e.depth) outcome.superseded.push(e.key);
            else outcome.failed.push(e.key);
          }
        }
      }
      await onChunk(outcome);
    }
  }
}

function isPermissionDenied(err: unknown): boolean {
  return (err as FirestoreError | undefined)?.code === 'permission-denied';
}

export function isQuotaExceeded(err: unknown): boolean {
  return (err as FirestoreError | undefined)?.code === 'resource-exhausted';
}
