import { Injectable, computed, effect, signal } from '@angular/core';
import { EngineInstance, EngineResult } from './engine-instance';

export type EvalPriority = 'high' | 'low';

interface Task {
  fen: string;
  depth: number;
  resolve: (r: EngineResult) => void;
  reject: (e: Error) => void;
}

const ENGINE_URL = '/engine/stockfish-19-lite-single.js';
const SETTINGS_KEY = 'engine-settings';
export const DEPTH_OPTIONS = [10, 12, 14, 16, 18, 20, 22] as const;

function defaultWorkers(): number {
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 2) : 2;
  return Math.max(1, Math.min(4, cores - 1));
}

function loadSettings(): { depth: number; workers: number } {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<{ depth: number; workers: number }>;
      return { depth: parsed.depth ?? 16, workers: parsed.workers ?? defaultWorkers() };
    }
  } catch {
    // Storage unavailable: fall back to defaults.
  }
  return { depth: 16, workers: defaultWorkers() };
}

/**
 * A pool of Stockfish workers with a two-level priority queue. Interactive
 * requests (the position on screen) jump ahead of bulk analysis, and bulk
 * callers keep only a few tasks queued so the switch is immediate.
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
      (priority === 'high' ? this.high : this.low).push({ fen, depth, resolve, reject });
      this.queued.set(this.high.length + this.low.length);
      this.ensureStarted();
      this.pump();
    });
  }

  /** Terminates all workers; the next request starts fresh ones. */
  shutdown(): void {
    for (const instance of this.instances) instance.terminate();
    this.instances.length = 0;
    this.started = false;
    for (const task of [...this.high, ...this.low]) task.reject(new Error('Engine pool shut down'));
    this.high.length = 0;
    this.low.length = 0;
    this.queued.set(0);
    this.active.set(0);
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.resize();
  }

  /** Brings the number of live workers in line with the setting. */
  private resize(): void {
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
      if (instance.busy) continue;
      const task = this.high.shift() ?? this.low.shift();
      if (!task) break;
      this.queued.set(this.high.length + this.low.length);
      this.active.update((n) => n + 1);
      instance
        .evaluate(task.fen, task.depth)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active.update((n) => n - 1);
          this.completed.update((n) => n + 1);
          this.pump();
        });
    }
  }
}
