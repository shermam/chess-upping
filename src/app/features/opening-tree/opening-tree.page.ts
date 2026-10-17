import { DatePipe, DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  input,
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
import { Chess, Square } from 'chess.js';
import type { Key } from 'chessground/types';
import { UserProfileService } from '../../core/auth/user-profile.service';
import { EvalStoreService } from '../../core/data/eval-store.service';
import { GamesStoreService } from '../../core/data/games-store.service';
import { PositionIndexService } from '../../core/data/position-index.service';
import {
  ExplorerResult,
  ExplorerSource,
  LichessExplorerService,
} from '../../core/explorer/lichess-explorer.service';
import { OpeningsService } from '../../core/openings/openings.service';
import { SyncService } from '../../core/data/sync.service';
import { EnginePoolService } from '../../core/engine/engine-pool.service';
import { LichessAuthService } from '../../core/lichess/lichess-auth.service';
import { Color, PERF_LABELS, STANDARD_PERFS } from '../../models/game';
import { formatSeconds } from '../../models/move-times';
import { PositionEval, formatEval, positionKey, whiteWinChance } from '../../models/position-eval';
import { NoteBoxComponent } from '../../shared/note-box.component';
import { BoardComponent, BoardMove } from './board.component';
import {
  DEFAULT_FILTERS,
  MoveStats,
  NodeEntry,
  ResultFilter,
  SortBy,
  TreeFilters,
  entriesAtLine,
  entriesAtPosition,
  nextMoveStatsFrom,
  percent,
  prepareGames,
  scoreClass,
  sortStats,
  tally,
} from './tree';

const PROMOTION_PIECES = ['q', 'r', 'b', 'n'] as const;
type PromotionPiece = (typeof PROMOTION_PIECES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
/** Candidate moves evaluated per node, most played first. */
const MAX_CANDIDATE_EVALS = 12;
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
    NoteBoxComponent,
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
  private readonly index = inject(PositionIndexService);
  private readonly openings = inject(OpeningsService);
  private readonly explorer = inject(LichessExplorerService);
  protected readonly sync = inject(SyncService);

  /** Optional `?line=e4,e5,Nf3` query parameter: open the explorer at this line. */
  readonly lineParam = input<string | undefined>(undefined, { alias: 'line' });

  /** Group games by position reached (merging transpositions) instead of by move order. */
  protected readonly mergeTranspositions = signal(true);
  protected readonly indexReady = this.index.ready;
  protected readonly indexProgress = computed(() =>
    this.index.total() === 0 ? 0 : (this.index.indexed() / this.index.total()) * 100,
  );
  protected readonly promotionPieces = PROMOTION_PIECES;
  /** A pending pawn move that needs a promotion piece before it is played. */
  protected readonly pendingPromotion = signal<BoardMove | null>(null);

  protected readonly explorerSource = signal<ExplorerSource | 'off'>('off');
  protected readonly explorerResult = signal<ExplorerResult | null>(null);
  protected readonly explorerError = signal<string | null>(null);
  private explorerRequest = 0;
  /** Bumped to make the board redraw after a cancelled promotion. */
  protected readonly boardRefresh = signal(0);
  /** The mode actually in effect: by position only once the index is complete. */
  protected readonly effectiveMode = computed(() =>
    this.mergeTranspositions() && this.indexReady() ? 'position' : 'order',
  );

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
  /** Games at the current node, each with the ply it continues from. */
  protected readonly entries = computed<NodeEntry[]>(() => {
    const prepared = this.prepared();
    if (this.mergeTranspositions() && this.indexReady()) {
      this.index.version();
      return entriesAtPosition(prepared, this.currentKey(), (id) => this.index.keysFor(id));
    }
    return entriesAtLine(prepared, this.line());
  });
  protected readonly atLine = computed(() => this.entries().map((e) => e.game));
  protected readonly totals = computed(() => tally(this.atLine()));
  protected readonly stats = computed(() =>
    sortStats(nextMoveStatsFrom(this.entries()), this.sortBy()),
  );
  /** Whether the user is the one to move at the current node. */
  protected readonly userToMove = computed(
    () => (this.line().length % 2 === 0) === (this.color() === 'white'),
  );
  protected readonly timeLabel = computed(() => (this.userToMove() ? 'Your time' : 'Their time'));
  /** Engine evaluations of the positions after each candidate move, keyed by SAN. */
  protected readonly candidateEvals = signal<ReadonlyMap<string, PositionEval>>(new Map());
  /** The moves in the table, as a string so the effect below re-runs only when the set changes. */
  private readonly candidateSans = computed(() =>
    this.stats()
      .slice(0, MAX_CANDIDATE_EVALS)
      .map((s) => s.san)
      .join(' '),
  );
  private candidateAbort: AbortController | null = null;
  private candidateFen = '';
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
  protected readonly currentKey = computed(() => positionKey(this.fen()));
  /** Position keys along the current line, start position first. */
  private readonly lineKeys = computed(() => {
    const chess = new Chess();
    const keys = [positionKey(chess.fen())];
    for (const san of this.line()) {
      try {
        chess.move(san);
      } catch {
        break;
      }
      keys.push(positionKey(chess.fen()));
    }
    return keys;
  });
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
    // The ECO dataset is keyed by position, so it names transpositions too.
    if (this.openings.ready()) {
      const hit = this.openings.nameForKeys(this.lineKeys());
      if (hit) return `${hit.eco} ${hit.name}`;
    }
    // Fallback: the deepest Lichess opening tag among games at this node that
    // the current line has fully reached.
    const depth = this.line().length;
    let best: { eco: string; name: string; ply: number } | null = null;
    for (const g of this.atLine()) {
      const opening = g.game.opening;
      if (opening && opening.ply <= depth && (!best || opening.ply > best.ply)) best = opening;
    }
    return best ? `${best.eco} ${best.name}` : null;
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
    void this.openings.load();
    effect(() => {
      const param = this.lineParam();
      if (param === undefined) return;
      const line = param.split(',').filter(Boolean);
      untracked(() => {
        // Only accept a replayable line; otherwise start from the initial position.
        const chess = new Chess();
        const ok: string[] = [];
        for (const san of line) {
          try {
            ok.push(chess.move(san).san);
          } catch {
            break;
          }
        }
        this.line.set(ok);
        // Make sure the tree is viewed from the side to move's opponent... no:
        // the explorer stays on the user's chosen colour; the line is shared.
      });
    });
    // Build the position index for the current games in the background.
    effect(() => {
      const games = this.store.games();
      if (games.length > 0) untracked(() => void this.index.ensure(games));
    });
    // Lichess explorer lookup for the position on the board, debounced.
    effect((onCleanup) => {
      const fen = this.fen();
      const source = this.explorerSource();
      const perfs = this.perfs();
      untracked(() => {
        // Invalidate any request still in flight for the previous position.
        this.explorerRequest++;
        this.explorerResult.set(null);
        this.explorerError.set(null);
      });
      if (source === 'off') return;
      const timer = setTimeout(() => void this.queryExplorer(source, fen, perfs), 400);
      onCleanup(() => clearTimeout(timer));
    });
    // Keep the engine line in step with the board, debounced so that
    // stepping quickly through moves evaluates only where the user stops.
    effect((onCleanup) => {
      const fen = this.fen();
      const linked = !!this.link();
      untracked(() => this.positionEval.set(null));
      if (!linked) return;
      const timer = setTimeout(() => void this.evaluateCurrent(fen), 250);
      onCleanup(() => clearTimeout(timer));
    });
    effect((onCleanup) => {
      const fen = this.fen();
      const sans = this.candidateSans();
      if (!this.link()) return;
      const timer = setTimeout(
        () => void this.evaluateCandidates(fen, sans ? sans.split(' ') : []),
        300,
      );
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
  }

  /**
   * Evaluates the position after each move in the table at low priority,
   * filling the eval column as results arrive. Re-run when the board or the
   * set of moves changes (filters, colour); only moves still missing an eval
   * are requested, and a superseded request is aborted so quick navigation
   * does not pile up searches.
   */
  private async evaluateCandidates(fen: string, sans: string[]): Promise<void> {
    this.candidateAbort?.abort();
    const abort = (this.candidateAbort = new AbortController());
    if (fen !== this.candidateFen) {
      this.candidateFen = fen;
      this.candidateEvals.set(new Map());
    }
    const known = this.candidateEvals();
    const fenBySan = new Map<string, string>();
    for (const san of sans) {
      if (known.has(san)) continue;
      try {
        const chess = new Chess(fen);
        chess.move(san);
        fenBySan.set(san, chess.fen());
      } catch {
        // A move that cannot be replayed from this position: leave it blank.
      }
    }
    if (fenBySan.size === 0) return;
    const sanByKey = new Map([...fenBySan].map(([san, f]) => [positionKey(f), san]));
    try {
      await this.evals.getOrEvaluate([...fenBySan.values()], this.pool.depth(), 'low', {
        signal: abort.signal,
        onResult: (e) => {
          if (abort.signal.aborted) return;
          const san = sanByKey.get(e.key);
          if (!san) return;
          this.candidateEvals.update((m) => new Map(m).set(san, e));
        },
      });
    } catch (err) {
      if (!abort.signal.aborted) console.warn('candidate evaluation failed', err);
    }
  }

  private async queryExplorer(
    source: ExplorerSource,
    fen: string,
    perfs: ReadonlySet<string>,
  ): Promise<void> {
    const request = ++this.explorerRequest;
    try {
      const result = await this.explorer.query(source, fen, {
        speeds: perfs.size > 0 ? [...perfs] : undefined,
      });
      if (request === this.explorerRequest) this.explorerResult.set(result);
    } catch (err) {
      if (request === this.explorerRequest) {
        this.explorerError.set(err instanceof Error ? err.message : String(err));
      }
    }
  }

  protected explorerTotal(
    r: ExplorerResult | { white: number; draws: number; black: number },
  ): number {
    return r.white + r.draws + r.black;
  }

  /** The user's result percentages for an explorer move, from the user's colour. */
  protected explorerWin(m: { white: number; draws: number; black: number }): number {
    const total = this.explorerTotal(m);
    return percent(this.color() === 'white' ? m.white : m.black, total);
  }

  protected explorerDraw(m: { white: number; draws: number; black: number }): number {
    return percent(m.draws, this.explorerTotal(m));
  }

  protected explorerLoss(m: { white: number; draws: number; black: number }): number {
    const total = this.explorerTotal(m);
    return percent(this.color() === 'white' ? m.black : m.white, total);
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
    this.pendingPromotion.set(null);
    this.line.update((l) => [...l, san]);
  }

  protected onBoardMove(move: BoardMove): void {
    this.pendingPromotion.set(null);
    const chess = new Chess(this.fen());
    const piece = chess.get(move.from as Square);
    const lastRank = move.to.endsWith('8') || move.to.endsWith('1');
    if (piece?.type === 'p' && lastRank) {
      // Let the user pick the piece; the board shows the pawn on the last
      // rank until the choice is made.
      this.pendingPromotion.set(move);
      return;
    }
    this.playBoardMove(move, undefined);
  }

  protected pieceName(piece: PromotionPiece): string {
    return { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[piece];
  }

  protected promote(piece: PromotionPiece): void {
    const move = this.pendingPromotion();
    this.pendingPromotion.set(null);
    if (move) this.playBoardMove(move, piece);
  }

  protected cancelPromotion(): void {
    this.pendingPromotion.set(null);
    // Redraw the board from the unchanged position (the pawn was shown on the last rank).
    this.boardRefresh.update((n) => n + 1);
  }

  private playBoardMove({ from, to }: BoardMove, promotion: PromotionPiece | undefined): void {
    const chess = new Chess(this.fen());
    try {
      const move = chess.move({ from: from as Square, to: to as Square, promotion });
      this.play(move.san);
    } catch {
      // Not a legal move: chessground only offers legal destinations, so this
      // should not happen; ignore defensively.
    }
  }

  protected back(): void {
    this.pendingPromotion.set(null);
    this.line.update((l) => l.slice(0, -1));
  }

  protected reset(): void {
    this.pendingPromotion.set(null);
    this.line.set([]);
  }

  protected goTo(ply: number): void {
    this.pendingPromotion.set(null);
    this.line.update((l) => l.slice(0, ply));
  }

  protected flip(): void {
    this.pendingPromotion.set(null);
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
