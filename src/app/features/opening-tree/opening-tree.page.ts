import { DatePipe, DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatChipListboxChange, MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { Chess } from 'chess.js';
import type { Key } from 'chessground/types';
import { UserProfileService } from '../../core/auth/user-profile.service';
import { EvalStoreService } from '../../core/data/eval-store.service';
import { GamesStoreService } from '../../core/data/games-store.service';
import { SyncService } from '../../core/data/sync.service';
import { EnginePoolService } from '../../core/engine/engine-pool.service';
import { LichessAuthService } from '../../core/lichess/lichess-auth.service';
import { Color, PERF_LABELS, STANDARD_PERFS } from '../../models/game';
import { formatSeconds } from '../../models/move-times';
import { PositionEval, formatEval, positionKey, whiteWinChance } from '../../models/position-eval';
import { BoardComponent, BoardMove } from './board.component';
import {
  DEFAULT_FILTERS,
  MoveStats,
  ResultFilter,
  SortBy,
  TreeFilters,
  gamesAtLine,
  nextMoveStats,
  percent,
  prepareGames,
  scoreClass,
  sortStats,
  tally,
} from './tree';

const DAY_MS = 24 * 60 * 60 * 1000;
export const PERIOD_OPTIONS = [
  { value: 0, label: 'All time' },
  { value: 30, label: 'Last month' },
  { value: 90, label: 'Last 3 months' },
  { value: 180, label: 'Last 6 months' },
  { value: 365, label: 'Last year' },
  { value: 730, label: 'Last 2 years' },
] as const;
export const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: 'games', label: 'Most played' },
  { value: 'score', label: 'Best score' },
  { value: 'recent', label: 'Most recent' },
  { value: 'time', label: 'Slowest' },
];

const GAME_LIST_LIMIT = 50;

@Component({
  selector: 'app-opening-tree-page',
  imports: [
    DatePipe,
    DecimalPipe,
    MatButtonModule,
    MatButtonToggleModule,
    MatCardModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatProgressBarModule,
    MatTooltipModule,
    RouterLink,
    BoardComponent,
  ],
  templateUrl: './opening-tree.page.html',
  styleUrl: './opening-tree.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OpeningTreePage {
  private readonly profiles = inject(UserProfileService);
  private readonly store = inject(GamesStoreService);
  private readonly lichessAuth = inject(LichessAuthService);
  private readonly evals = inject(EvalStoreService);
  private readonly pool = inject(EnginePoolService);
  protected readonly sync = inject(SyncService);

  /** Engine evaluation of the position on the board, fetched or computed on demand. */
  protected readonly positionEval = signal<PositionEval | null>(null);
  protected readonly evalText = computed(() => {
    const e = this.positionEval();
    return e ? formatEval(e) : null;
  });
  protected readonly bestMoveSan = computed(() => {
    const e = this.positionEval();
    if (!e?.bestMove) return null;
    try {
      const chess = new Chess(this.fen());
      return chess.move({
        from: e.bestMove.slice(0, 2),
        to: e.bestMove.slice(2, 4),
        promotion: e.bestMove[4],
      }).san;
    } catch {
      return null;
    }
  });
  private evalRequest = 0;

  protected readonly perfOptions = STANDARD_PERFS;
  protected readonly perfLabels = PERF_LABELS;
  protected readonly periodOptions = PERIOD_OPTIONS;
  protected readonly sortOptions = SORT_OPTIONS;
  protected readonly percent = percent;
  protected readonly formatSeconds = formatSeconds;
  protected readonly formatEval = formatEval;
  protected readonly whiteWinChance = whiteWinChance;

  protected readonly link = computed(() => this.profiles.profile()?.lichess ?? null);
  protected readonly profileLoading = computed(() => this.profiles.profile() === undefined);
  protected readonly totalGames = computed(() => this.store.games().length);

  protected readonly color = signal<Color>('white');
  protected readonly perfs = signal<ReadonlySet<string>>(new Set());
  protected readonly rated = signal<TreeFilters['rated']>('all');
  protected readonly result = signal<ResultFilter>('all');
  protected readonly periodDays = signal<number>(0);
  protected readonly ratingMin = signal<number | null>(null);
  protected readonly ratingMax = signal<number | null>(null);
  protected readonly sortBy = signal<SortBy>('games');
  protected readonly line = signal<string[]>([]);

  private readonly prepared = computed(() => {
    const link = this.link();
    if (!link) return [];
    const days = this.periodDays();
    return prepareGames(this.store.games(), link.id, {
      ...DEFAULT_FILTERS,
      color: this.color(),
      perfs: this.perfs(),
      rated: this.rated(),
      result: this.result(),
      since: days > 0 ? Date.now() - days * DAY_MS : null,
      ratingMin: this.ratingMin(),
      ratingMax: this.ratingMax(),
    });
  });
  protected readonly atLine = computed(() => gamesAtLine(this.prepared(), this.line()));
  protected readonly totals = computed(() => tally(this.atLine()));
  protected readonly stats = computed(() =>
    sortStats(nextMoveStats(this.atLine(), this.line().length), this.sortBy()),
  );
  /** Whether the user is the one to move at the current node. */
  protected readonly userToMove = computed(
    () => (this.line().length % 2 === 0) === (this.color() === 'white'),
  );
  protected readonly timeLabel = computed(() => (this.userToMove() ? 'Your time' : 'Their time'));
  /** Engine evaluations of the positions after each candidate move, keyed by SAN. */
  protected readonly candidateEvals = signal<ReadonlyMap<string, PositionEval>>(new Map());
  private candidateRequest = 0;
  protected readonly recentGames = computed(() => this.atLine().slice(0, GAME_LIST_LIMIT));
  protected readonly filteredCount = computed(() => this.prepared().length);

  private readonly position = computed(() => {
    const chess = new Chess();
    for (const san of this.line()) {
      try {
        chess.move(san);
      } catch {
        break;
      }
    }
    return chess;
  });
  protected readonly fen = computed(() => this.position().fen());
  protected readonly turn = computed<Color>(() =>
    this.position().turn() === 'w' ? 'white' : 'black',
  );
  protected readonly dests = computed(() => {
    const map = new Map<Key, Key[]>();
    for (const m of this.position().moves({ verbose: true })) {
      const list = map.get(m.from as Key) ?? [];
      list.push(m.to as Key);
      map.set(m.from as Key, list);
    }
    return map;
  });
  protected readonly lastMove = computed<Key[] | null>(() => {
    const history = this.position().history({ verbose: true });
    const last = history[history.length - 1];
    return last ? [last.from as Key, last.to as Key] : null;
  });
  protected readonly openingName = computed(() => {
    // Lichess tags each game with the deepest opening it recognises and the
    // ply where that name applies. Among games at this node, the deepest tag
    // that the current line has fully reached names the position.
    const depth = this.line().length;
    let best: { name: string; ply: number } | null = null;
    for (const g of this.atLine()) {
      const opening = g.game.opening;
      if (opening && opening.ply <= depth && (!best || opening.ply > best.ply)) best = opening;
    }
    return best?.name ?? null;
  });
  /** Pairs of plies for the breadcrumb: [moveNumber, whiteSan, blackSan?]. */
  protected readonly movePairs = computed(() => {
    const line = this.line();
    const pairs: { n: number; white: string; black: string | null; whiteIdx: number }[] = [];
    for (let i = 0; i < line.length; i += 2) {
      pairs.push({ n: i / 2 + 1, white: line[i], black: line[i + 1] ?? null, whiteIdx: i });
    }
    return pairs;
  });

  constructor() {
    // Keep the engine line in step with the board, debounced so that
    // stepping quickly through moves evaluates only where the user stops.
    effect((onCleanup) => {
      const fen = this.fen();
      const linked = !!this.link();
      untracked(() => {
        this.positionEval.set(null);
        this.candidateEvals.set(new Map());
      });
      if (!linked) return;
      const timer = setTimeout(() => void this.evaluateCurrent(fen), 250);
      onCleanup(() => clearTimeout(timer));
    });
  }

  private async evaluateCurrent(fen: string): Promise<void> {
    const request = ++this.evalRequest;
    const key = positionKey(fen);
    try {
      const result = await this.evals.getOrEvaluate([fen], this.pool.depth(), 'high');
      if (request === this.evalRequest) this.positionEval.set(result.get(key) ?? null);
    } catch (err) {
      console.warn('position evaluation failed', err);
    }
    void this.evaluateCandidates(fen, request);
  }

  /** Evaluates the position after each move in the table, filling the eval column as results arrive. */
  private async evaluateCandidates(fen: string, request: number): Promise<void> {
    const candidateRequest = ++this.candidateRequest;
    const sans = this.stats().map((s) => s.san);
    const fenBySan = new Map<string, string>();
    for (const san of sans) {
      try {
        const chess = new Chess(fen);
        chess.move(san);
        fenBySan.set(san, chess.fen());
      } catch {
        // A move the engine's FEN cannot replay: leave its eval blank.
      }
    }
    const sanByKey = new Map([...fenBySan].map(([san, f]) => [positionKey(f), san]));
    if (fenBySan.size === 0 || request !== this.evalRequest) return;
    const found = new Map<string, PositionEval>();
    try {
      await this.evals.getOrEvaluate([...fenBySan.values()], this.pool.depth(), 'low', {
        onResult: (e) => {
          if (candidateRequest !== this.candidateRequest) return;
          const san = sanByKey.get(e.key);
          if (!san) return;
          found.set(san, e);
          this.candidateEvals.set(new Map(found));
        },
      });
    } catch (err) {
      console.warn('candidate evaluation failed', err);
    }
  }

  protected scoreClassFor(row: MoveStats): string {
    return scoreClass(row, this.totals()) ?? '';
  }

  protected setResult(result: ResultFilter): void {
    this.result.set(result);
  }

  protected setRating(which: 'min' | 'max', value: string): void {
    const n = value.trim() === '' ? null : Number(value);
    const clean = n === null || Number.isNaN(n) ? null : n;
    (which === 'min' ? this.ratingMin : this.ratingMax).set(clean);
  }

  protected play(san: string): void {
    this.line.update((l) => [...l, san]);
  }

  protected onBoardMove({ from, to }: BoardMove): void {
    const chess = new Chess(this.fen());
    try {
      const move = chess.move({ from, to, promotion: 'q' });
      this.play(move.san);
    } catch {
      // Not a legal move: chessground only offers legal destinations, so this
      // should not happen; ignore defensively.
    }
  }

  protected back(): void {
    this.line.update((l) => l.slice(0, -1));
  }

  protected reset(): void {
    this.line.set([]);
  }

  protected goTo(ply: number): void {
    this.line.update((l) => l.slice(0, ply));
  }

  protected flip(): void {
    this.color.update((c) => (c === 'white' ? 'black' : 'white'));
    this.line.set([]);
  }

  protected setColor(color: Color): void {
    if (color !== this.color()) {
      this.color.set(color);
      this.line.set([]);
    }
  }

  protected setPerfs(change: MatChipListboxChange): void {
    const value = change.value as string[] | string | undefined;
    const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
    this.perfs.set(new Set(list));
  }

  protected setRated(rated: TreeFilters['rated']): void {
    this.rated.set(rated);
  }

  protected connectLichess(): void {
    void this.lichessAuth.startLogin('/');
  }

  protected syncNow(): void {
    const link = this.link();
    if (link) void this.sync.sync(link);
  }

  protected perfLabel(perf: string): string {
    return (PERF_LABELS as Record<string, string>)[perf] ?? perf;
  }

  protected lichessUrl(id: string): string {
    return `https://lichess.org/${id}`;
  }

  @HostListener('window:keydown', ['$event'])
  protected onKey(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
      return;
    if (event.key === 'ArrowLeft') {
      this.back();
      event.preventDefault();
    } else if (event.key === 'ArrowRight') {
      const top = this.stats()[0];
      if (top) this.play(top.san);
      event.preventDefault();
    } else if (event.key === 'Home') {
      this.reset();
      event.preventDefault();
    }
  }
}
