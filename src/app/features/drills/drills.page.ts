import { DecimalPipe } from '@angular/common';
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
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { Chess, Square } from 'chess.js';
import type { Key } from 'chessground/types';
import { UserProfileService } from '../../core/auth/user-profile.service';
import { GamesStoreService } from '../../core/data/games-store.service';
import { PositionIndexService } from '../../core/data/position-index.service';
import { OpeningsService } from '../../core/openings/openings.service';
import { Color } from '../../models/game';
import { formatSeconds } from '../../models/move-times';
import { BoardComponent, BoardMove } from '../opening-tree/board.component';
import { DrillCard, buildCards } from './cards';
import { DrillsService } from './drills.service';
import { Grade } from './scheduler';

type ColorChoice = Color | 'both';

interface Outcome {
  correct: boolean;
  played: string;
  seconds: number;
}

@Component({
  selector: 'app-drills-page',
  imports: [
    DecimalPipe,
    MatButtonModule,
    MatButtonToggleModule,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
    RouterLink,
    BoardComponent,
  ],
  templateUrl: './drills.page.html',
  styleUrl: './drills.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DrillsPage {
  private readonly store = inject(GamesStoreService);
  private readonly profiles = inject(UserProfileService);
  private readonly index = inject(PositionIndexService);
  private readonly openings = inject(OpeningsService);
  protected readonly drills = inject(DrillsService);

  protected readonly formatSeconds = formatSeconds;
  protected readonly colorChoice = signal<ColorChoice>('both');
  protected readonly minGames = signal(3);
  protected readonly indexReady = this.index.ready;
  protected readonly indexProgress = computed(() =>
    this.index.total() === 0 ? 0 : (this.index.indexed() / this.index.total()) * 100,
  );

  private readonly cards = computed<DrillCard[]>(() => {
    const link = this.profiles.profile()?.lichess;
    if (!link || !this.indexReady()) return [];
    this.index.version();
    const choice = this.colorChoice();
    return buildCards(this.store.games(), link.id, (id) => this.index.keysFor(id), {
      minGames: this.minGames(),
      minShare: 0.5,
      colors: choice === 'both' ? ['white', 'black'] : [choice],
    });
  });
  protected readonly queue = computed(() => this.drills.queue(this.cards()));
  protected readonly totalCards = computed(() => this.cards().length);

  /** The card on the board; chosen when the previous one is answered. */
  protected readonly card = signal<DrillCard | null>(null);
  protected readonly outcome = signal<Outcome | null>(null);
  private startedAt = 0;

  protected readonly fen = computed(() => {
    const c = this.card();
    return c
      ? `${c.key.replace(/_/g, '/')} 0 1`
      : 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  });
  private readonly position = computed(() => new Chess(this.fen()));
  protected readonly dests = computed(() => {
    const map = new Map<Key, Key[]>();
    if (this.outcome()) return map;
    for (const m of this.position().moves({ verbose: true })) {
      const list = map.get(m.from as Key) ?? [];
      list.push(m.to as Key);
      map.set(m.from as Key, list);
    }
    return map;
  });
  protected readonly turn = computed<Color>(() =>
    this.position().turn() === 'w' ? 'white' : 'black',
  );
  /** After answering, highlight the expected move on the board. */
  protected readonly highlight = computed<Key[] | null>(() => {
    const c = this.card();
    if (!c || !this.outcome()) return null;
    try {
      const m = new Chess(this.fen()).move(c.expected);
      return [m.from as Key, m.to as Key];
    } catch {
      return null;
    }
  });
  protected readonly boardFen = computed(() => {
    // Show the expected move played once answered.
    const c = this.card();
    if (!c || !this.outcome()) return this.fen();
    try {
      const chess = new Chess(this.fen());
      chess.move(c.expected);
      return chess.fen();
    } catch {
      return this.fen();
    }
  });
  protected readonly openingName = computed(() => {
    const c = this.card();
    if (!c || !this.openings.ready()) return null;
    const hit = this.openings.lookup(c.key);
    return hit ? `${hit.eco} ${hit.name}` : null;
  });
  protected readonly lineText = computed(() => {
    const c = this.card();
    if (!c) return '';
    return c.line.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san)).join(' ');
  });

  constructor() {
    void this.openings.load();
    effect(() => {
      const games = this.store.games();
      if (games.length > 0) untracked(() => void this.index.ensure(games));
    });
    // Pick a card whenever there is none on the board and the queue has one.
    effect(() => {
      const q = this.queue();
      if (this.card() !== null) return;
      const next = q.due[0] ?? q.fresh[0] ?? null;
      untracked(() => this.show(next));
    });
  }

  private show(card: DrillCard | null): void {
    this.card.set(card);
    this.outcome.set(null);
    this.startedAt = Date.now();
  }

  protected onBoardMove({ from, to }: BoardMove): void {
    const card = this.card();
    if (!card || this.outcome()) return;
    let san: string;
    try {
      san = new Chess(this.fen()).move({
        from: from as Square,
        to: to as Square,
        promotion: 'q',
      }).san;
    } catch {
      return;
    }
    const seconds = (Date.now() - this.startedAt) / 1000;
    this.outcome.set({ correct: san === card.expected, played: san, seconds });
  }

  protected next(): void {
    const card = this.card();
    const outcome = this.outcome();
    if (!card || !outcome) return;
    const grade: Grade = !outcome.correct ? 'again' : outcome.seconds <= 3 ? 'easy' : 'good';
    void this.drills.record(card, grade);
    this.card.set(null);
  }

  protected skip(): void {
    const card = this.card();
    if (card) {
      this.drills.skipped.update((s) => new Set(s).add(card.key));
      this.drills.lastShown.set(card.key);
    }
    this.card.set(null);
  }

  protected explorerParams(card: DrillCard): { [k: string]: string } {
    return { line: card.line.join(','), color: card.color };
  }

  @HostListener('window:keydown', ['$event'])
  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && this.outcome()) {
      this.next();
      event.preventDefault();
    }
  }
}
