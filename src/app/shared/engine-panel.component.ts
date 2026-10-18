import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
} from '@angular/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Chess } from 'chess.js';
import { LiveEngineService, LiveLine, MULTI_PV_OPTIONS } from '../core/engine/live-engine.service';
import { formatEval, whiteWinChance } from '../models/position-eval';

interface ShownLine {
  rank: number;
  score: string;
  whiteShare: number;
  /** SAN moves, with move numbers where a White move starts. */
  moves: { san: string; label: string }[];
  depth: number;
}

/**
 * Live engine panel for any board: a switch, the number of lines, and the
 * principal variations for the position in `fen`, updating as the engine
 * deepens. Clicking the first move of a line plays it on the board.
 */
@Component({
  selector: 'app-engine-panel',
  imports: [MatButtonToggleModule, MatSlideToggleModule, MatTooltipModule],
  template: `
    <div class="head">
      <mat-slide-toggle
        [checked]="engine.enabled()"
        (change)="engine.toggle()"
        [disabled]="!engine.supported"
      >
        Engine
      </mat-slide-toggle>
      @if (engine.enabled()) {
        <span class="muted small">
          @if (engine.error(); as e) {
            {{ e }}
          } @else if (engine.depth() > 0) {
            depth {{ engine.depth() }}{{ engine.searching() ? '…' : '' }}
          } @else {
            starting…
          }
        </span>
        <span class="spacer"></span>
        <mat-button-toggle-group
          hideSingleSelectionIndicator
          [value]="engine.multiPv()"
          (change)="engine.multiPv.set($event.value)"
          aria-label="Number of lines"
          matTooltip="Number of lines"
        >
          @for (n of options; track n) {
            <mat-button-toggle [value]="n">{{ n }}</mat-button-toggle>
          }
        </mat-button-toggle-group>
      }
    </div>
    @if (engine.enabled()) {
      <ol class="lines">
        @for (line of shown(); track line.rank) {
          <li>
            <span class="score" [class.black]="line.whiteShare < 50">{{ line.score }}</span>
            <span class="moves">
              @for (m of line.moves; track $index) {
                @if ($index === 0) {
                  <button
                    class="san first"
                    (click)="play.emit(m.san)"
                    [matTooltip]="'Play ' + m.san"
                  >
                    {{ m.label }}
                  </button>
                } @else {
                  <span class="san">{{ m.label }}</span>
                }
              }
            </span>
          </li>
        } @empty {
          @if (engine.terminal() && engine.searchFen() === fen()) {
            <li class="muted small">No legal moves: the game is over.</li>
          } @else if (!engine.error()) {
            <li class="muted small">Thinking…</li>
          }
        }
      </ol>
    }
  `,
  styles: `
    :host {
      display: block;
      margin-top: 8px;
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--mat-sys-surface-container);
    }
    .head {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      min-height: 32px;
    }
    .spacer {
      flex: 1;
    }
    .muted {
      color: var(--mat-sys-on-surface-variant);
    }
    .small {
      font: var(--mat-sys-body-small);
    }
    .lines {
      list-style: none;
      margin: 6px 0 0;
      padding: 0;
      font: var(--mat-sys-body-medium);
    }
    .lines li {
      display: flex;
      gap: 10px;
      align-items: baseline;
      padding: 3px 0;
      border-top: 1px solid var(--mat-sys-outline-variant);
    }
    .score {
      min-width: 3.6em;
      padding: 1px 6px;
      border-radius: 4px;
      text-align: center;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      background: #fff;
      color: #222;
      border: 1px solid #c8c8c8;
      &.black {
        background: #403d39;
        color: #fff;
        border-color: #403d39;
      }
    }
    .moves {
      display: flex;
      flex-wrap: wrap;
      gap: 2px 6px;
    }
    .san {
      font: inherit;
      background: none;
      border: 0;
      padding: 0 2px;
      color: inherit;
    }
    .san.first {
      font-weight: 600;
      cursor: pointer;
      border-radius: 4px;
      &:hover {
        background: var(--mat-sys-surface-container-high);
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnginePanelComponent {
  protected readonly engine = inject(LiveEngineService);
  protected readonly options = MULTI_PV_OPTIONS;

  /** Full FEN of the position on the board. */
  readonly fen = input.required<string>();
  /** Emits the SAN of a move the user clicked in a line. */
  readonly play = output<string>();

  protected readonly shown = computed<ShownLine[]>(() => {
    const fen = this.fen();
    if (this.engine.searchFen() !== fen) return [];
    return this.engine.lines().map((line) => toShown(fen, line));
  });

  constructor() {
    effect(() => {
      const fen = this.fen();
      this.engine.setPosition(fen);
    });
    inject(DestroyRef).onDestroy(() => this.engine.setPosition(null));
  }
}

function toShown(fen: string, line: LiveLine): ShownLine {
  const chess = new Chess(fen);
  const moves: { san: string; label: string }[] = [];
  let moveNo = chess.moveNumber();
  let whiteToMove = chess.turn() === 'w';
  for (const uci of line.pv) {
    try {
      const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      const label = whiteToMove
        ? `${moveNo}. ${m.san}`
        : moves.length === 0
          ? `${moveNo}… ${m.san}`
          : m.san;
      moves.push({ san: m.san, label });
      if (!whiteToMove) moveNo++;
      whiteToMove = !whiteToMove;
    } catch {
      break;
    }
  }
  const e = { cp: line.cp, mate: line.mate, fen };
  return {
    rank: line.rank,
    score: formatEval(e),
    whiteShare: whiteWinChance(e) * 100,
    moves,
    depth: line.depth,
  };
}
