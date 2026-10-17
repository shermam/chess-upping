import { Injectable, computed, effect, signal } from '@angular/core';
import { EngineInstance, EngineResult } from './engine-instance';

export type EvalPriority = 'high' | 'low';

interface Task {
  fen: string;
  depth: number;
  retries: number;
  resolve: (r: EngineResult) => void;
  reject: (e: Error) => void;
}

const ENGINE_URL = '/engine/stockfish-19-lite-single.js';
const SETTINGS_KEY = 'engine-settings';
/** How many times a task is handed to a fresh worker after one died under it. */
const MAX_RETRIES = 2;
export const DEPTH_OPTIONS = [10, 12, 14, 16, 18, 20, 22] as const;

function defaultWorkers(): number {
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 2) : 2;
  return Math.max(1, Math.min(4, cores - 1));
}

function nearestDepth(depth: number): number {
  return DEPTH_OPTIONS.reduce((best, d) =>
    Math.abs(d - depth) < Math.abs(best - depth) ? d : best,
  );
}

function loadSettings(): { depth: number; workers: number } {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<{ depth: number; workers: number }>;
      return {
        depth: nearestDepth(parsed.depth ?? 16),
        workers: parsed.workers ?? defaultWorkers(),
      };
    }
  } catch {
    // Storage unavailable: fall back to defaults.
  }
  return { depth: 16, workers: defaultWorkers() };
}

/**
 * A pool of Stockfish workers with a two-level priority queue. Interactive
 * requests (the position on screen) are served before bulk analysis. A worker
 * that dies is dropped and its task handed to a replacement.
 */
@Injectable({ providedIn: 'root' })
export class EnginePoolService {
  private readonly instances: EngineInstance[] = [];
  private readonly high: Task[] = [];
  private readonly low: Task[] = [];
  private started = false;

  readonly maxWorkers = Math.max(
    1,
    (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 2) ?? 2,
  );
  readonly depth = signal(loadSettings().depth);
  readonly workers = signal(Math.min(loadSettings().workers, this.maxWorkers));
  readonly active = signal(0);
  readonly queued = signal(0);
  readonly completed = signal(0);
  readonly running = computed(() => this.active() > 0 || this.queued() > 0);
  /** Last worker failure, for the UI; cleared when a worker succeeds again. */
  readonly lastError = signal<string | null>(null);

  constructor() {
    effect(() => {
      const settings = { depth: this.depth(), workers: this.workers() };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch {
        // Ignore storage failures.
      }
    });
  }

  evaluate(fen: string, depth: number, priority: EvalPriority): Promise<EngineResult> {
    return new Promise<EngineResult>((resolve, reject) => {
      this.enqueue({ fen, depth, retries: 0, resolve, reject }, priority);
    });
  }

  private enqueue(task: Task, priority: EvalPriority): void {
    (priority === 'high' ? this.high : this.low).push(task);
    this.queued.set(this.high.length + this.low.length);
    this.started = true;
    this.pump();
  }

  /** Brings the number of live workers in line with the setting. */
  private resize(): void {
    for (let i = this.instances.length - 1; i >= 0; i--) {
      if (this.instances[i].dead) this.instances.splice(i, 1);
    }
    while (this.instances.length < this.workers()) {
      this.instances.push(new EngineInstance(ENGINE_URL));
    }
    // Shrinking drops idle workers only; busy ones retire after their task.
    for (let i = this.instances.length - 1; i >= this.workers() && i >= 0; i--) {
      if (!this.instances[i].busy) {
        this.instances[i].terminate();
        this.instances.splice(i, 1);
      }
    }
  }

  private pump(): void {
    if (!this.started) return;
    this.resize();
    for (const instance of this.instances) {
      if (instance.busy || instance.dead) continue;
      const task = this.high.shift() ?? this.low.shift();
      if (!task) break;
      this.queued.set(this.high.length + this.low.length);
      this.active.update((n) => n + 1);
      instance.evaluate(task.fen, task.depth).then(
        (result) => {
          this.active.update((n) => n - 1);
          this.completed.update((n) => n + 1);
          this.lastError.set(null);
          task.resolve(result);
          this.pump();
        },
        (err: Error) => {
          this.active.update((n) => n - 1);
          if (instance.dead && task.retries < MAX_RETRIES) {
            // The worker died under this task: hand it to a replacement.
            this.lastError.set(err.message);
            task.retries++;
            this.enqueue(task, 'high');
          } else {
            this.lastError.set(err.message);
            task.reject(err);
            this.pump();
          }
        },
      );
    }
  }
}
