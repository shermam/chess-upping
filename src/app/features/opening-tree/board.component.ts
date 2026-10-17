import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Config } from 'chessground/config';
import type { Key } from 'chessground/types';
import { Color } from '../../models/game';

export interface BoardMove {
  from: Key;
  to: Key;
}

/** Thin Angular wrapper around Lichess's chessground board. */
@Component({
  selector: 'app-board',
  template: '<div class="board" #board></div>',
  styles: `
    :host {
      display: block;
      width: 100%;
    }
    .board {
      width: 100%;
      aspect-ratio: 1 / 1;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardComponent {
  readonly fen = input.required<string>();
  readonly orientation = input<Color>('white');
  readonly turnColor = input<Color>('white');
  readonly dests = input<Map<Key, Key[]>>(new Map());
  readonly lastMove = input<Key[] | null>(null);
  readonly move = output<BoardMove>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('board');
  private api: Api | null = null;

  private readonly config = computed<Config>(() => ({
    fen: this.fen(),
    orientation: this.orientation(),
    turnColor: this.turnColor(),
    lastMove: this.lastMove() ?? undefined,
    coordinates: true,
    animation: { enabled: true, duration: 150 },
    movable: {
      free: false,
      color: this.turnColor(),
      dests: this.dests(),
      showDests: true,
      events: { after: (from, to) => this.move.emit({ from, to }) },
    },
    draggable: { showGhost: true },
    highlight: { lastMove: true, check: true },
  }));

  constructor() {
    afterNextRender(() => {
      this.api = Chessground(this.host().nativeElement, this.config());
    });
    effect(() => {
      const config = this.config();
      this.api?.set(config);
    });
    inject(DestroyRef).onDestroy(() => this.api?.destroy());
  }
}
