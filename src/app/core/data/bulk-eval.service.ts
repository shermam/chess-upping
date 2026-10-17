import { Injectable, computed, inject, signal } from '@angular/core';
import { Chess } from 'chess.js';
import { Game } from '../../models/game';
import { EnginePoolService } from '../engine/engine-pool.service';
import { EvalStoreService } from './eval-store.service';
import { GamesStoreService } from './games-store.service';
import { LocalDbService } from './local-db.service';

export type BulkPhase = 'idle' | 'running' | 'paused' | 'done' | 'error';

/** Replays a game and returns the full FEN after every ply, starting position included. */
export function gamePositions(game: Game): string[] {
  const chess = new Chess();
  const fens = [chess.fen()];
  for (const san of game.moves.split(' ')) {
    try {
      chess.move(san);
    } catch {
      break;
    }
    fens.push(chess.fen());
  }
  return fens;
}

/**
 * Evaluates every position of every game the user played, newest game first,
 * at the depth configured in the engine settings. Progress is kept per game
 * in IndexedDB, so the job resumes where it stopped and skips games already
 * covered at the requested depth. Runs as long as the tab stays open.
 */
@Injectable({ providedIn: 'root' })
export class BulkEvalService {
  private readonly store = inject(GamesStoreService);
  private readonly db = inject(LocalDbService);
  private readonly evals = inject(EvalStoreService);
  private readonly pool = inject(EnginePoolService);

  private stopRequested = false;
  private pauseRequested = false;
  private loop: Promise<void> | null = null;

  readonly phase = signal<BulkPhase>('idle');
  readonly depth = signal(0);
  readonly gamesTotal = signal(0);
  readonly gamesDone = signal(0);
  readonly currentGame = signal<Game | null>(null);
  readonly positionsEvaluated = signal(0);
  readonly positionsCached = signal(0);
  readonly startedAt = signal<number | null>(null);
  readonly error = signal<string | null>(null);

  readonly gamesLeft = computed(() => Math.max(0, this.gamesTotal() - this.gamesDone()));
  /** Positions evaluated per minute since the job started. */
  readonly rate = computed(() => {
    const started = this.startedAt();
    if (!started || this.positionsEvaluated() === 0) return 0;
    return (this.positionsEvaluated() / Math.max(1, Date.now() - started)) * 60_000;
  });

  /** Counts games already covered at the current engine depth. */
  async refresh(): Promise<void> {
    const depth = this.pool.depth();
    const depths = await this.db.gameEvalDepths();
    const games = this.store.games();
    this.gamesTotal.set(games.length);
    this.gamesDone.set(games.filter((g) => (depths.get(g.id) ?? 0) >= depth).length);
    await this.evals.refreshCounts();
  }

  start(): void {
    if (this.loop) {
      this.pauseRequested = false;
      this.phase.set('running');
      return;
    }
    this.stopRequested = false;
    this.pauseRequested = false;
    this.error.set(null);
    this.positionsEvaluated.set(0);
    this.positionsCached.set(0);
    this.startedAt.set(Date.now());
    this.depth.set(this.pool.depth());
    this.phase.set('running');
    this.loop = this.run().finally(() => {
      this.loop = null;
      this.currentGame.set(null);
    });
  }

  pause(): void {
    if (!this.loop) return;
    this.pauseRequested = true;
    this.phase.set('paused');
  }

  stop(): void {
    this.stopRequested = true;
    this.pauseRequested = false;
    if (!this.loop) this.phase.set('idle');
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.pauseRequested && !this.stopRequested) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  private async run(): Promise<void> {
    const depth = this.depth();
    try {
      const depths = await this.db.gameEvalDepths();
      const games = [...this.store.games()].sort((a, b) => b.createdAt - a.createdAt);
      this.gamesTotal.set(games.length);
      this.gamesDone.set(games.filter((g) => (depths.get(g.id) ?? 0) >= depth).length);
      let sinceUpload = 0;
      for (const game of games) {
        if (this.stopRequested) break;
        await this.waitWhilePaused();
        if (this.stopRequested) break;
        if ((depths.get(game.id) ?? 0) >= depth) continue;
        this.currentGame.set(game);
        const fens = gamePositions(game);
        let computed = 0;
        await this.evals.getOrEvaluate(fens, depth, 'low', {
          onResult: (_e, source) => {
            if (source === 'engine') computed++;
          },
        });
        const cached = fens.length - computed;
        this.positionsEvaluated.update((n) => n + computed);
        this.positionsCached.update((n) => n + cached);
        await this.db.setGameEval({
          gameId: game.id,
          depth,
          positions: fens.length,
          evaluatedAt: Date.now(),
        });
        depths.set(game.id, depth);
        this.gamesDone.update((n) => n + 1);
        sinceUpload += fens.length;
        if (sinceUpload >= 400) {
          sinceUpload = 0;
          void this.evals.uploadPending();
        }
      }
      await this.evals.uploadPending();
      await this.evals.refreshCounts();
      this.phase.set(this.stopRequested ? 'idle' : 'done');
    } catch (err) {
      console.error('bulk evaluation failed', err);
      this.error.set(err instanceof Error ? err.message : String(err));
      this.phase.set('error');
    }
  }
}
