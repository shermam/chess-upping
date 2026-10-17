import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import { BulkEvalService } from '../../core/data/bulk-eval.service';
import { EvalStoreService } from '../../core/data/eval-store.service';
import { GamesStoreService } from '../../core/data/games-store.service';
import { DEPTH_OPTIONS, EnginePoolService } from '../../core/engine/engine-pool.service';

@Component({
  selector: 'app-engine-page',
  imports: [
    DecimalPipe,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatProgressBarModule,
    MatSelectModule,
    RouterLink,
  ],
  templateUrl: './engine.page.html',
  styleUrl: './engine.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnginePage {
  protected readonly bulk = inject(BulkEvalService);
  protected readonly pool = inject(EnginePoolService);
  protected readonly evals = inject(EvalStoreService);
  private readonly store = inject(GamesStoreService);

  protected readonly depthOptions = DEPTH_OPTIONS;
  protected readonly workerOptions = Array.from({ length: this.pool.maxWorkers }, (_, i) => i + 1);

  protected readonly progress = computed(() => {
    const total = this.bulk.gamesTotal();
    return total === 0 ? 0 : (this.bulk.gamesDone() / total) * 100;
  });
  /** Average positions per game, used for the estimate. */
  private readonly avgPositions = computed(() => {
    const games = this.store.games();
    if (games.length === 0) return 0;
    const plies = games.reduce((sum, g) => sum + g.moves.split(' ').length + 1, 0);
    return plies / games.length;
  });
  protected readonly etaMinutes = computed(() => {
    const rate = this.bulk.rate();
    if (rate <= 0) return null;
    return (this.bulk.gamesLeft() * this.avgPositions()) / rate;
  });
  protected readonly running = computed(() => this.bulk.phase() === 'running');
  protected readonly paused = computed(() => this.bulk.phase() === 'paused');

  constructor() {
    // Recount whenever the games or the target depth change.
    effect(() => {
      this.store.games();
      this.pool.depth();
      void this.bulk.refresh();
    });
  }

  protected formatEta(minutes: number): string {
    if (minutes < 1) return 'under a minute';
    if (minutes < 90) return `about ${Math.round(minutes)} min`;
    return `about ${(minutes / 60).toFixed(1)} h`;
  }

  protected uploadNow(): void {
    void this.evals.uploadPending();
  }
}
