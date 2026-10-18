import { DatePipe } from '@angular/common';
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
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { Chess, Square } from 'chess.js';
import type { Key } from 'chessground/types';
import { UserProfileService } from '../../core/auth/user-profile.service';
import { EvalStoreService } from '../../core/data/eval-store.service';
import { LocalDbService } from '../../core/data/local-db.service';
import { EnginePoolService } from '../../core/engine/engine-pool.service';
import { OpeningsService } from '../../core/openings/openings.service';
import { Color, Game, PERF_LABELS } from '../../models/game';
import { PositionEval, formatEval, positionKey, whiteWinChance } from '../../models/position-eval';
import { BoardComponent, BoardMove } from '../opening-tree/board.component';
import { EvalGraphComponent, EvalPoint } from './eval-graph.component';
import { EnginePanelComponent } from '../../shared/engine-panel.component';
import { NoteBoxComponent } from '../../shared/note-box.component';
import { JUDGEMENT_SYMBOL, JudgedMove, accuracy, judgeMoves } from '../../models/analysis';

interface Ply {
  /** 0 for the start position, then 1..n after each move. */
  ply: number;
  fen: string;
  key: string;
  san: string | null;
  from: Key | null;
  to: Key | null;
}

function replay(game: Game): Ply[] {
  const chess = new Chess();
  const plies: Ply[] = [
    { ply: 0, fen: chess.fen(), key: positionKey(chess.fen()), san: null, from: null, to: null },
  ];
  for (const san of game.moves.split(' ')) {
    let move;
    try {
      move = chess.move(san);
    } catch {
      break;
    }
    const fen = chess.fen();
    plies.push({
      ply: plies.length,
      fen,
      key: positionKey(fen),
      san: move.san,
      from: move.from as Key,
      to: move.to as Key,
    });
  }
  return plies;
}

/** Converts a UCI move list into SAN from the given position; stops at the first illegal move. */
function uciToSan(fen: string, uci: string[]): string[] {
  const chess = new Chess(fen);
  const out: string[] = [];
  for (const m of uci) {
    try {
      const move = chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
      out.push(move.san);
    } catch {
      break;
    }
  }
  return out;
}

@Component({
  selector: 'app-game-page',
  imports: [
    DatePipe,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatTooltipModule,
    RouterLink,
    BoardComponent,
    EvalGraphComponent,
    NoteBoxComponent,
    EnginePanelComponent,
  ],
  templateUrl: './game.page.html',
  styleUrl: './game.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GamePage {
  private readonly db = inject(LocalDbService);
  private readonly evals = inject(EvalStoreService);
  private readonly pool = inject(EnginePoolService);
  private readonly profiles = inject(UserProfileService);
  private readonly openings = inject(OpeningsService);

  /** Opening name from the ECO dataset (position based), falling back to the Lichess tag. */
  protected readonly openingName = computed(() => {
    const g = this.game();
    if (!g) return null;
    if (this.openings.ready()) {
      const hit = this.openings.nameForKeys(this.plies().map((p) => p.key));
      if (hit) return `${hit.eco} ${hit.name}`;
    }
    return g.opening ? `${g.opening.eco} ${g.opening.name}` : null;
  });

  /** Route parameter, bound by `withComponentInputBinding`. */
  readonly id = input.required<string>();
  /** Optional `?ply=` query parameter: the move to open the game at. */
  readonly plyParam = input<string | undefined>(undefined, { alias: 'ply' });

  protected readonly symbol = JUDGEMENT_SYMBOL;
  /** Judged moves keyed by ply, from the evaluations gathered so far. */
  protected readonly judged = computed(() => {
    const map = new Map<number, JudgedMove>();
    for (const m of judgeMoves(this.plies(), this.evalMap())) map.set(m.ply, m);
    return map;
  });
  protected readonly accuracyText = computed(() => {
    const moves = [...this.judged().values()];
    const w = accuracy(moves, 'white');
    const b = accuracy(moves, 'black');
    return w === null && b === null ? null : `${w ?? '–'}% / ${b ?? '–'}%`;
  });
  protected readonly graphPoints = computed<EvalPoint[]>(() =>
    this.plies().map((p) => ({
      ply: p.ply,
      san: p.san,
      eval: this.evalMap().get(p.key) ?? null,
      judgement: this.judged().get(p.ply)?.judgement ?? null,
    })),
  );

  protected readonly game = signal<Game | null | undefined>(undefined);
  protected readonly plies = computed(() => {
    const g = this.game();
    return g ? replay(g) : [];
  });
  protected readonly ply = signal(0);
  protected readonly current = computed(() => this.plies()[this.ply()] ?? null);
  /** Moves played on the board from the current ply, exploring away from the game. */
  protected readonly variation = signal<string[]>([]);
  /** The position on the board: the game at `ply`, plus any variation. */
  protected readonly boardState = computed(() => {
    const c = this.current();
    const base = c?.fen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const chess = new Chess(base);
    let last: { from: Key; to: Key } | null = c?.from && c.to ? { from: c.from, to: c.to } : null;
    const played: string[] = [];
    for (const san of this.variation()) {
      try {
        const m = chess.move(san);
        last = { from: m.from as Key, to: m.to as Key };
        played.push(m.san);
      } catch {
        break;
      }
    }
    return {
      fen: chess.fen(),
      last,
      played,
      turn: chess.turn() === 'w' ? 'white' : 'black',
    } as const;
  });
  protected readonly boardFen = computed(() => this.boardState().fen);
  protected readonly dests = computed(() => {
    const map = new Map<Key, Key[]>();
    for (const m of new Chess(this.boardFen()).moves({ verbose: true })) {
      const list = map.get(m.from as Key) ?? [];
      list.push(m.to as Key);
      map.set(m.from as Key, list);
    }
    return map;
  });
  /** Variation moves with numbers, for display. */
  protected readonly variationText = computed(() => {
    const c = this.current();
    const base = c ? new Chess(c.fen) : new Chess();
    let no = base.moveNumber();
    let white = base.turn() === 'w';
    return this.boardState().played.map((san, i) => {
      const label = white ? `${no}. ${san}` : i === 0 ? `${no}… ${san}` : san;
      if (!white) no++;
      white = !white;
      return label;
    });
  });
  protected readonly evalMap = signal<Map<string, PositionEval>>(new Map());
  protected readonly evaluating = signal(false);
  protected readonly evaluated = computed(
    () => this.plies().filter((p) => this.evalMap().has(p.key)).length,
  );
  protected readonly targetDepth = this.pool.depth;

  protected readonly userColor = computed<Color>(() => {
    const g = this.game();
    const me = this.profiles.profile()?.lichess?.id;
    return g && me && g.black.id === me ? 'black' : 'white';
  });
  protected readonly currentEval = computed(() => {
    const c = this.current();
    return c ? (this.evalMap().get(c.key) ?? null) : null;
  });
  protected readonly evalText = computed(() => {
    const e = this.currentEval();
    return e ? formatEval(e) : '…';
  });
  protected readonly whiteBar = computed(() => {
    const e = this.currentEval();
    return e ? whiteWinChance(e) * 100 : 50;
  });
  protected readonly bestLine = computed(() => {
    const e = this.currentEval();
    const c = this.current();
    if (!e || !c || !e.bestMove) return [];
    return uciToSan(c.fen, e.pv ? e.pv.split(' ') : [e.bestMove]);
  });
  protected readonly turn = computed<Color>(() => this.boardState().turn);
  protected readonly lastMove = computed<Key[] | null>(() => {
    const last = this.boardState().last;
    return last ? [last.from, last.to] : null;
  });
  /** Rows for the move list: move number, white ply, black ply. */
  protected readonly rows = computed(() => {
    const plies = this.plies();
    const rows: { n: number; white: Ply; black: Ply | null }[] = [];
    for (let i = 1; i < plies.length; i += 2) {
      rows.push({ n: (i + 1) / 2, white: plies[i], black: plies[i + 1] ?? null });
    }
    return rows;
  });

  private loadRequest = 0;
  private loadAbort: AbortController | null = null;

  constructor() {
    void this.openings.load();
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
    // `?ply=` can change without the game changing (history navigation).
    effect(() => {
      this.plyParam();
      const count = this.plies().length;
      untracked(() => this.applyPlyParam(count));
    });
  }

  private applyPlyParam(plyCount: number): void {
    const param = this.plyParam();
    if (typeof param !== 'string' || plyCount === 0) return;
    const wanted = Number(param);
    if (Number.isInteger(wanted) && wanted > 0) {
      this.variation.set([]);
      this.ply.set(Math.min(wanted, plyCount - 1));
    }
  }

  private async load(id: string): Promise<void> {
    // A newer navigation wins: earlier loads must not touch the state again.
    const request = ++this.loadRequest;
    this.loadAbort?.abort();
    const abort = (this.loadAbort = new AbortController());
    this.ply.set(0);
    this.variation.set([]);
    this.evalMap.set(new Map());
    const game = await this.db.getGame(id);
    if (request !== this.loadRequest) return;
    this.game.set(game ?? null);
    if (!game) return;
    const plies = replay(game);
    this.applyPlyParam(plies.length);
    await this.evaluateAll(plies, request, abort.signal);
  }

  private async evaluateAll(plies: Ply[], request: number, signal: AbortSignal): Promise<void> {
    this.evaluating.set(true);
    try {
      await this.evals.getOrEvaluate(
        plies.map((p) => p.fen),
        this.pool.depth(),
        'high',
        {
          signal,
          onResult: (e) => {
            if (request !== this.loadRequest) return;
            this.evalMap.update((m) => {
              const next = new Map(m);
              next.set(e.key, e);
              return next;
            });
          },
        },
      );
      void this.evals.uploadPending();
    } catch (err) {
      if (!signal.aborted) console.error('game evaluation failed', err);
    } finally {
      if (request === this.loadRequest) this.evaluating.set(false);
    }
  }

  protected evalFor(p: Ply): string {
    const e = this.evalMap().get(p.key);
    return e ? formatEval(e) : '';
  }

  protected judgementFor(p: Ply): string {
    return this.judged().get(p.ply)?.judgement ?? '';
  }

  protected badgeFor(p: Ply): string {
    const j = this.judged().get(p.ply)?.judgement;
    return j ? JUDGEMENT_SYMBOL[j] : '';
  }

  protected goTo(ply: number): void {
    const max = this.plies().length - 1;
    this.variation.set([]);
    this.ply.set(Math.max(0, Math.min(max, ply)));
  }

  /** A move made on the board explores a variation from the current position. */
  protected onBoardMove({ from, to }: BoardMove): void {
    try {
      const chess = new Chess(this.boardFen());
      const m = chess.move({ from: from as Square, to: to as Square, promotion: 'q' });
      this.variation.update((v) => [...v, m.san]);
    } catch {
      // Illegal: chessground only offers legal destinations.
    }
  }

  /** Plays a SAN move from the engine panel on the current board position. */
  protected playSan(san: string): void {
    try {
      new Chess(this.boardFen()).move(san);
      this.variation.update((v) => [...v, san]);
    } catch {
      // Not legal here.
    }
  }

  protected backOne(): void {
    if (this.variation().length > 0) this.variation.update((v) => v.slice(0, -1));
    else this.goTo(this.ply() - 1);
  }

  protected leaveVariation(): void {
    this.variation.set([]);
  }

  protected perfLabel(perf: string): string {
    return (PERF_LABELS as Record<string, string>)[perf] ?? perf;
  }

  protected result(g: Game): string {
    return g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : '½-½';
  }

  @HostListener('window:keydown', ['$event'])
  protected onKey(event: KeyboardEvent): void {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('input, textarea, select')) return;
    switch (event.key) {
      case 'ArrowLeft':
        this.backOne();
        break;
      case 'ArrowRight':
        this.goTo(this.ply() + 1);
        break;
      case 'Home':
        this.goTo(0);
        break;
      case 'End':
        this.goTo(this.plies().length - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}
