import { DatePipe, DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { UserProfileService } from '../../core/auth/user-profile.service';
import { GamesStoreService } from '../../core/data/games-store.service';
import { Mistake, MistakeFinderService } from '../../core/data/mistake-finder.service';
import { JUDGEMENT_SYMBOL, Judgement } from '../../models/analysis';
import { Color } from '../../models/game';

type Severity = 'mistakes' | 'all';

interface OpeningGroup {
  opening: string;
  blunders: number;
  mistakes: number;
  inaccuracies: number;
  items: Mistake[];
}

interface PositionGroup {
  key: string;
  opening: string;
  moveNumber: string;
  count: number;
  items: Mistake[];
  lineBefore: string[];
}

@Component({
  selector: 'app-mistakes-page',
  imports: [
    DatePipe,
    DecimalPipe,
    MatButtonModule,
    MatButtonToggleModule,
    MatCardModule,
    MatExpansionModule,
    MatIconModule,
    MatProgressBarModule,
    RouterLink,
  ],
  templateUrl: './mistakes.page.html',
  styleUrl: './mistakes.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MistakesPage {
  protected readonly finder = inject(MistakeFinderService);
  private readonly store = inject(GamesStoreService);
  private readonly profiles = inject(UserProfileService);

  protected readonly symbol = JUDGEMENT_SYMBOL;
  protected readonly color = signal<Color | 'both'>('both');
  protected readonly severity = signal<Severity>('mistakes');
  protected readonly totalGames = computed(() => this.store.games().length);

  private readonly filtered = computed(() => {
    const report = this.finder.report();
    if (!report) return [];
    const color = this.color();
    const severity = this.severity();
    return report.mistakes.filter(
      (m) =>
        (color === 'both' || m.color === color) &&
        (severity === 'all' || m.judgement !== 'inaccuracy'),
    );
  });
  protected readonly counts = computed(() => {
    const c = { blunder: 0, mistake: 0, inaccuracy: 0 };
    for (const m of this.filtered()) c[m.judgement]++;
    return c;
  });
  protected readonly judgedMoves = computed(() => {
    const report = this.finder.report();
    if (!report) return 0;
    const color = this.color();
    return color === 'both'
      ? report.judgedMoves.white + report.judgedMoves.black
      : report.judgedMoves[color];
  });
  protected readonly byOpening = computed<OpeningGroup[]>(() => {
    const groups = new Map<string, OpeningGroup>();
    for (const m of this.filtered()) {
      let g = groups.get(m.opening);
      if (!g) {
        g = { opening: m.opening, blunders: 0, mistakes: 0, inaccuracies: 0, items: [] };
        groups.set(m.opening, g);
      }
      if (m.judgement === 'blunder') g.blunders++;
      else if (m.judgement === 'mistake') g.mistakes++;
      else g.inaccuracies++;
      g.items.push(m);
    }
    return [...groups.values()].sort(
      (a, b) =>
        b.blunders - a.blunders || b.mistakes - a.mistakes || b.inaccuracies - a.inaccuracies,
    );
  });
  protected readonly repeated = computed<PositionGroup[]>(() => {
    const groups = new Map<string, PositionGroup>();
    for (const m of this.filtered()) {
      let g = groups.get(m.keyBefore);
      if (!g) {
        g = {
          key: m.keyBefore,
          opening: m.opening,
          moveNumber: `${Math.ceil(m.ply / 2)}${m.ply % 2 ? '.' : '…'}`,
          count: 0,
          items: [],
          lineBefore: m.lineBefore,
        };
        groups.set(m.keyBefore, g);
      }
      g.count++;
      g.items.push(m);
    }
    return [...groups.values()].filter((g) => g.count >= 2).sort((a, b) => b.count - a.count);
  });

  constructor() {
    // Analyse when the games change (or on first visit); a change that lands
    // while a run is in progress starts a fresh run right after it.
    effect(() => {
      const games = this.store.games();
      const link = this.profiles.profile()?.lichess;
      const running = this.finder.running();
      if (games.length === 0 || !link) return;
      untracked(() => {
        if (running || this.finder.isCurrent(games, link.id)) return;
        void this.finder.analyse(games, link.id);
      });
    });
  }

  protected rerun(): void {
    const games = this.store.games();
    const link = this.profiles.profile()?.lichess;
    if (games.length > 0 && link) void this.finder.analyse(games, link.id);
  }

  protected moveLabel(m: Mistake): string {
    return `${Math.ceil(m.ply / 2)}${m.ply % 2 ? '.' : '…'} ${m.san}`;
  }

  protected explorerLink(line: string[], color: Color): { [k: string]: string } {
    return { line: line.join(','), color };
  }

  protected judgementClass(j: Judgement): string {
    return j;
  }
}
