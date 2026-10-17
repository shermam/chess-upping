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

/**
 * One Stockfish WebAssembly engine running in its own Web Worker, driven over
 * the UCI protocol through postMessage. Single-threaded build, so no
 * cross-origin isolation is needed.
 */
export class EngineInstance {
  private readonly worker: Worker;
  private pending: Pending | null = null;
  /** Set synchronously when a task is accepted, before the engine is ready. */
  private reserved = false;
  private waiters = new Map<string, () => void>();
  private readyPromise: Promise<void>;
  private dead = false;

  constructor(scriptUrl: string, hashMb = 32) {
    this.worker = new Worker(scriptUrl);
    this.worker.onmessage = (ev: MessageEvent<unknown>) => this.onLine(String(ev.data));
    this.worker.onerror = (ev) => this.fail(new Error(`Engine worker error: ${ev.message}`));
    this.readyPromise = this.boot(hashMb);
  }

  get busy(): boolean {
    return this.reserved || this.pending !== null;
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  private async boot(hashMb: number): Promise<void> {
    await this.sendAndWait('uci', 'uciok');
    this.send(`setoption name Hash value ${hashMb}`);
    this.send('setoption name UCI_AnalyseMode value true');
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
    if (this.dead) throw new Error('Engine terminated');
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
    this.dead = true;
    this.worker.terminate();
    this.fail(new Error('Engine terminated'));
  }

  private onLine(line: string): void {
    const waiter = this.waiters.get(line.trim());
    if (waiter) {
      this.waiters.delete(line.trim());
      waiter();
      return;
    }
    if (!this.pending) return;
    const info = parseInfo(line);
    if (info) {
      this.pending.info = pickBetter(this.pending.info, info);
      return;
    }
    const best = parseBestMove(line);
    if (best) {
      const { resolve, info: finalInfo } = this.pending;
      this.pending = null;
      resolve({ info: finalInfo, bestMove: best.bestMove });
    }
  }

  private fail(err: Error): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(err);
  }
}
