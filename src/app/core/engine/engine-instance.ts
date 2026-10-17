import { UciInfo, parseBestMove, parseInfo, pickBetter } from './uci';

export interface EngineResult {
  info: UciInfo | null;
  bestMove: string | null;
}

interface Pending {
  resolve: (r: EngineResult) => void;
  reject: (e: Error) => void;
  info: UciInfo | null;
}

/** How long the worker may take to answer `uci`/`isready` before it is given up on. */
const BOOT_TIMEOUT_MS = 60_000;

/**
 * One Stockfish WebAssembly engine running in its own Web Worker, driven over
 * the UCI protocol through postMessage. Single-threaded build, so no
 * cross-origin isolation is needed. Once the worker errors it is `dead`: every
 * pending and future request rejects, and the pool replaces it.
 */
export class EngineInstance {
  private readonly worker: Worker;
  private pending: Pending | null = null;
  /** Set synchronously when a task is accepted, before the engine is ready. */
  private reserved = false;
  private waiters = new Map<string, () => void>();
  private readonly readyPromise: Promise<void>;
  private readyReject: ((e: Error) => void) | null = null;
  private deadError: Error | null = null;

  constructor(scriptUrl: string, hashMb = 32) {
    this.worker = new Worker(scriptUrl);
    this.worker.onmessage = (ev: MessageEvent<unknown>) => this.onLine(String(ev.data));
    this.worker.onerror = (ev) =>
      this.die(new Error(`Engine worker error: ${ev.message || 'unknown'}`));
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyReject = reject;
      const timer = setTimeout(
        () => this.die(new Error('Engine did not start within 60 seconds')),
        BOOT_TIMEOUT_MS,
      );
      this.boot(hashMb).then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
    // Avoid an unhandled rejection when nobody is waiting on readiness yet.
    this.readyPromise.catch(() => undefined);
  }

  get busy(): boolean {
    return this.reserved || this.pending !== null;
  }

  get dead(): boolean {
    return this.deadError !== null;
  }

  private async boot(hashMb: number): Promise<void> {
    await this.sendAndWait('uci', 'uciok');
    this.send(`setoption name Hash value ${hashMb}`);
    await this.sendAndWait('isready', 'readyok');
  }

  private send(command: string): void {
    this.worker.postMessage(command);
  }

  private sendAndWait(command: string, token: string): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.set(token, resolve);
      this.send(command);
    });
  }

  /** Searches `fen` to `depth` and resolves with the final info and best move. */
  async evaluate(fen: string, depth: number): Promise<EngineResult> {
    if (this.deadError) throw this.deadError;
    if (this.busy) throw new Error('Engine is busy');
    this.reserved = true;
    try {
      await this.readyPromise;
      return await new Promise<EngineResult>((resolve, reject) => {
        this.pending = { resolve, reject, info: null };
        this.send(`position fen ${fen}`);
        this.send(`go depth ${depth}`);
      });
    } finally {
      this.reserved = false;
    }
  }

  terminate(): void {
    this.die(new Error('Engine terminated'));
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    const waiter = this.waiters.get(trimmed);
    if (waiter) {
      this.waiters.delete(trimmed);
      waiter();
      return;
    }
    if (!this.pending) return;
    const info = parseInfo(trimmed);
    if (info) {
      this.pending.info = pickBetter(this.pending.info, info);
      return;
    }
    const best = parseBestMove(trimmed);
    if (best) {
      const { resolve, info: finalInfo } = this.pending;
      this.pending = null;
      resolve({ info: finalInfo, bestMove: best.bestMove });
    }
  }

  private die(err: Error): void {
    if (this.deadError) return;
    this.deadError = err;
    this.worker.terminate();
    this.readyReject?.(err);
    const pending = this.pending;
    this.pending = null;
    pending?.reject(err);
  }
}
