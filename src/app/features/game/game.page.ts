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
import { Chess } from 'chess.js';
import type { Key } from 'chessground/types';
import { UserProfileService } from '../../core/auth/user-profile.service';
import { EvalStoreService } from '../../core/data/eval-store.service';
import { LocalDbService } from '../../core/data/local-db.service';
import { EnginePoolService } from '../../core/engine/engine-pool.service';
import { Color, Game, PERF_LABELS } from '../../models/game';
import { PositionEval, formatEval, positionKey, whiteWinChance } from '../../models/position-eval';
import { BoardComponent } from '../opening-tree/board.component';

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

  /** Route parameter, bound by `withComponentInputBinding`. */
  readonly id = input.required<string>();

  protected readonly game = signal<Game | null | undefined>(undefined);
  protected readonly plies = computed(() => {
    const g = this.game();
    return g ? replay(g) : [];
  });
  protected readonly ply = signal(0);
  protected readonly current = computed(() => this.plies()[this.ply()] ?? null);
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
  protected readonly turn = computed<Color>(() =>
    this.current()?.fen.split(' ')[1] === 'b' ? 'black' : 'white',
  );
  protected readonly lastMove = computed<Key[] | null>(() => {
    const c = this.current();
    return c?.from && c.to ? [c.from, c.to] : null;
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

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string): Promise<void> {
    this.ply.set(0);
    this.evalMap.set(new Map());
    const game = await this.db.getGame(id);
    this.game.set(game ?? null);
    if (!game) return;
    await this.evaluateAll(replay(game));
  }

  private async evaluateAll(plies: Ply[]): Promise<void> {
    this.evaluating.set(true);
    try {
      await this.evals.getOrEvaluate(
        plies.map((p) => p.fen),
        this.pool.depth(),
        'high',
        {
          onResult: (e) =>
            this.evalMap.update((m) => {
              const next = new Map(m);
              next.set(e.key, e);
              return next;
            }),
        },
      );
      void this.evals.uploadPending();
    } catch (err) {
      console.error('game evaluation failed', err);
    } finally {
      this.evaluating.set(false);
    }
  }

  protected evalFor(p: Ply): string {
    const e = this.evalMap().get(p.key);
    return e ? formatEval(e) : '';
  }

  protected goTo(ply: number): void {
    const max = this.plies().length - 1;
    this.ply.set(Math.max(0, Math.min(max, ply)));
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
        this.goTo(this.ply() - 1);
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
