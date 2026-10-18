import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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
import { EvalStoreService } from '../../core/data/eval-store.service';
import { EnginePoolService } from '../../core/engine/engine-pool.service';
import { GamesStoreService } from '../../core/data/games-store.service';
import { MistakeFinderService } from '../../core/data/mistake-finder.service';
import { PositionIndexService } from '../../core/data/position-index.service';
import { OpeningsService } from '../../core/openings/openings.service';
import { JUDGEMENT_SYMBOL } from '../../models/analysis';
import { Color } from '../../models/game';
import { formatSeconds } from '../../models/move-times';
import { positionKey } from '../../models/position-eval';
import { EnginePanelComponent } from '../../shared/engine-panel.component';
import { NoteBoxComponent } from '../../shared/note-box.component';
import { BoardComponent, BoardMove } from '../opening-tree/board.component';
import {
  CardKind,
  DrillCard,
  Reply,
  buildCards,
  buildMistakeCards,
  buildReplies,
  cardStateId,
  withoutBadHabits,
} from './cards';
import { DrillsService } from './drills.service';
import { GradeResult, MAX_ACCEPTED_DROP, MoveGraderService } from './move-grader.service';
import { Grade } from './scheduler';

type ColorChoice = Color | 'both';
type SourceChoice = CardKind | 'both';
type Mode = 'single' | 'sequence';

/** Where the current card stands: waiting for a move, grading it, the opponent replying, or finished. */
type Stage = 'answer' | 'checking' | 'replying' | 'done';

interface Outcome {
  correct: boolean;
  /** The move that ended the drill: the last accepted one or the refused one. */
  played: string;
  /** Thinking time over all the user's moves, in seconds. */
  seconds: number;
  /** User moves accepted before the drill ended. */
  solved: number;
  result: GradeResult;
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** One move in the navigable move list. */
interface MoveChip {
  /** Position reached after this move, as an index into the timeline. */
  ply: number;
  label: string;
  kind: 'history' | 'drill';
}

/** Most user moves in a sequence drill before it is declared solved. */
const MAX_SEQUENCE_MOVES = 3;
/** Pause before the opponent's reply appears, so the user's move registers visually. */
const REPLY_DELAY_MS = 450;

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
    EnginePanelComponent,
    NoteBoxComponent,
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
  private readonly grader = inject(MoveGraderService);
  private readonly evals = inject(EvalStoreService);
  private readonly pool = inject(EnginePoolService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly finder = inject(MistakeFinderService);
  protected readonly drills = inject(DrillsService);

  protected readonly formatSeconds = formatSeconds;
  protected readonly maxDrop = MAX_ACCEPTED_DROP;
  protected readonly colorChoice = signal<ColorChoice>('both');
  protected readonly source = signal<SourceChoice>('both');
  protected readonly mode = signal<Mode>('single');
  protected readonly minGames = signal(3);
  protected readonly indexReady = this.index.ready;
  protected readonly indexProgress = computed(() =>
    this.index.total() === 0 ? 0 : (this.index.indexed() / this.index.total()) * 100,
  );
  private readonly colors = computed<Color[]>(() => {
    const choice = this.colorChoice();
    return choice === 'both' ? ['white', 'black'] : [choice];
  });

  private readonly habitCards = computed<DrillCard[]>(() => {
    const link = this.profiles.profile()?.lichess;
    if (!link || !this.indexReady()) return [];
    this.index.version();
    return buildCards(this.store.games(), link.id, (id) => this.index.keysFor(id), {
      minGames: this.minGames(),
      minShare: 0.5,
      colors: this.colors(),
    });
  });
  private readonly mistakeCards = computed<DrillCard[]>(() => {
    const report = this.finder.report();
    return report ? buildMistakeCards(report.mistakes, this.colors()) : [];
  });
  /** Habits that are recorded mistakes are not drilled as habits. */
  private readonly repertoireCards = computed<DrillCard[]>(() =>
    withoutBadHabits(this.habitCards(), this.mistakeCards()),
  );
  /** Habitual move by position, to continue an opening sequence. */
  private readonly repertoireByKey = computed(() => {
    const map = new Map<string, DrillCard>();
    for (const c of this.repertoireCards()) map.set(c.key, c);
    return map;
  });
  /** The opponents' most common reply by position, to play in opening sequences. */
  private readonly replies = computed<Map<string, Reply>>(() => {
    const link = this.profiles.profile()?.lichess;
    if (!link || !this.indexReady()) return new Map();
    this.index.version();
    return buildReplies(this.store.games(), link.id, (id) => this.index.keysFor(id), {
      minGames: 2,
      minShare: 0,
      colors: this.colors(),
    });
  });
  /** Cards for the chosen source: mistakes first when mixed, as they are fewer and matter more. */
  private readonly cards = computed<DrillCard[]>(() => {
    switch (this.source()) {
      case 'repertoire':
        return this.repertoireCards();
      case 'mistake':
        return this.mistakeCards();
      default:
        return interleave(this.mistakeCards(), this.repertoireCards());
    }
  });
  protected readonly queue = computed(() => this.drills.queue(this.cards()));
  protected readonly totalCards = computed(() => this.cards().length);
  protected readonly mistakeCount = computed(() => this.mistakeCards().length);
  protected readonly repertoireCount = computed(() => this.repertoireCards().length);
  /** The mistake analysis is wanted when mistake cards are in play and the report is stale. */
  protected readonly analysing = computed(
    () => this.source() !== 'repertoire' && this.finder.running(),
  );

  /** The card on the board; chosen when the previous one is answered. */
  protected readonly card = signal<DrillCard | null>(null);
  protected readonly stage = signal<Stage>('answer');
  /** Moves played from the card position so far: user moves and automatic replies, alternating. */
  protected readonly played = signal<string[]>([]);
  /** The user's move being graded, shown on the board until it is accepted or refused. */
  private readonly pending = signal<string | null>(null);
  /** The move to find now: the habitual or engine move, when one is known. */
  private readonly expected = signal<string | null>(null);
  protected readonly outcome = signal<Outcome | null>(null);
  /** Moves explored on the board after the drill ended. */
  protected readonly explore = signal<string[]>([]);
  private startedAt = 0;
  private thinkMs = 0;
  /** Bumped when a card is shown, so a late grading result for an old card is ignored. */
  private attempt = 0;
  private replyTimer: ReturnType<typeof setTimeout> | null = null;

  /** The card's starting position. */
  protected readonly fen = computed(() => {
    const c = this.card();
    return c ? `${c.key.replace(/_/g, '/')} 0 1` : START_FEN;
  });
  /** The position the user is answering from (after the moves played so far). */
  protected readonly currentFen = computed(() => playLine(this.fen(), this.played()));
  /**
   * How the drill position was reached in the user's games: the one move
   * order when every game used the same, else the card's own line and the
   * number of different orders. A single order can be walked back through;
   * several cannot, so navigation then stops at the drill position.
   */
  protected readonly history = computed<{ moves: string[]; orders: number }>(() => {
    const c = this.card();
    if (!c) return { moves: [], orders: 0 };
    this.index.version();
    const orders = new Map<string, number>();
    for (const g of this.store.games()) {
      const keys = this.index.keysFor(g.id);
      const at = keys ? keys.indexOf(c.key) : -1;
      if (at < 0) continue;
      const prefix = g.moves.split(' ').slice(0, at).join(' ');
      orders.set(prefix, (orders.get(prefix) ?? 0) + 1);
    }
    if (orders.size === 1) {
      const [only] = orders.keys();
      return { moves: only ? only.split(' ') : [], orders: 1 };
    }
    // Not indexed (deep in a game): the card's own game is the only order known.
    return { moves: c.line, orders: orders.size === 0 ? 1 : orders.size };
  });
  /** Moves before the drill position that can be navigated: the unambiguous history. */
  private readonly prefix = computed(() => {
    const h = this.history();
    return h.orders === 1 ? h.moves : [];
  });
  /**
   * The moves from the drill position currently on the board at the live
   * end: the moves played, the move being graded, the engine's best move
   * after a wrong answer, and anything explored afterwards.
   */
  private readonly shownMoves = computed<string[]>(() => {
    const o = this.outcome();
    const played = this.played();
    if (!o) {
      const pending = this.pending();
      return pending ? [...played, pending] : played;
    }
    const best = !o.correct && o.result.best ? [o.result.best] : [];
    return [...played, ...best, ...this.explore()];
  });
  /** Every move that can be stepped through, history first. */
  private readonly timeline = computed(() => [...this.prefix(), ...this.shownMoves()]);
  /** Index of the drill position in the timeline. */
  protected readonly startPly = computed(() => this.prefix().length);
  /** The positions along the timeline, one more than there are moves. */
  private readonly positions = computed<string[]>(() => {
    const root = this.prefix().length > 0 ? START_FEN : this.fen();
    const chess = new Chess(root);
    const fens = [chess.fen()];
    for (const san of this.timeline()) {
      try {
        chess.move(san);
      } catch {
        break;
      }
      fens.push(chess.fen());
    }
    return fens;
  });
  /** Where the user is looking: null is the live end, where moves are made. */
  private readonly cursor = signal<number | null>(null);
  protected readonly viewPly = computed(() => {
    const last = this.positions().length - 1;
    const c = this.cursor();
    return c === null ? last : Math.max(0, Math.min(c, last));
  });
  protected readonly atLive = computed(() => this.viewPly() === this.positions().length - 1);
  /** What the board shows: the position being looked at. */
  protected readonly boardFen = computed(() => this.positions()[this.viewPly()]);
  /** Index of the first explored move in the timeline: positions from there on can be branched from. */
  private readonly exploreFrom = computed(
    () => this.startPly() + this.shownMoves().length - this.explore().length,
  );
  /** Moves can be made at the live end, and after the drill from any explored position. */
  private readonly movable = computed(() => {
    if (this.stage() === 'checking' || this.stage() === 'replying') return false;
    if (this.atLive()) return true;
    return this.outcome() !== null && this.viewPly() >= this.exploreFrom();
  });
  protected readonly dests = computed(() => {
    const map = new Map<Key, Key[]>();
    if (!this.movable()) return map;
    for (const m of new Chess(this.boardFen()).moves({ verbose: true })) {
      const list = map.get(m.from as Key) ?? [];
      list.push(m.to as Key);
      map.set(m.from as Key, list);
    }
    return map;
  });
  protected readonly turn = computed<Color>(() =>
    new Chess(this.boardFen()).turn() === 'w' ? 'white' : 'black',
  );
  /**
   * Highlights the last move on the board: the move stepped to, the move
   * being graded, the last automatic reply, the final accepted move, or the
   * engine's best move after a wrong answer.
   */
  protected readonly highlight = computed<Key[] | null>(() => {
    if (!this.atLive()) {
      const ply = this.viewPly();
      return ply === 0 ? null : squaresOf(this.positions()[ply - 1], this.timeline()[ply - 1]);
    }
    const o = this.outcome();
    if (o && this.explore().length > 0) return null;
    if (o && !o.correct) return o.result.best ? squaresOf(this.currentFen(), o.result.best) : null;
    const pending = this.pending();
    if (!o && pending) return squaresOf(this.currentFen(), pending);
    const played = this.played();
    if (played.length === 0) return null;
    const before = playLine(this.fen(), played.slice(0, -1));
    return squaresOf(before, played[played.length - 1]);
  });
  /** The move list under the board: history (when navigable) and the drill's moves. */
  protected readonly chips = computed<MoveChip[]>(() => {
    const prefix = this.prefix();
    const base = prefix.length > 0 ? 0 : this.history().moves.length;
    return this.timeline().map((san, k) => {
      const ply = base + k;
      const n = Math.floor(ply / 2) + 1;
      const label =
        ply % 2 === 0 ? `${n}. ${san}` : k === 0 || k === prefix.length ? `${n}… ${san}` : san;
      return { ply: k + 1, label, kind: k < prefix.length ? 'history' : 'drill' };
    });
  });
  protected readonly openingName = computed(() => {
    const c = this.card();
    if (!c || !this.openings.ready()) return null;
    if (c.opening) return c.opening;
    const hit = this.openings.lookup(c.key);
    return hit ? `${hit.eco} ${hit.name}` : null;
  });
  protected readonly lineText = computed(() => {
    const c = this.card();
    if (!c) return '';
    return c.line.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san)).join(' ');
  });
  protected readonly userMoves = computed(() => Math.ceil(this.played().length / 2));

  /**
   * The position a note written here is attached to: the position being
   * answered; once the drill has ended, the last decision point (where a
   * wrong move was refused, or before the last accepted move); and the
   * position on the board while exploring. Notes are the same private
   * position notes the explorer and the game viewer show.
   */
  protected readonly noteKey = computed(() => {
    if (!this.atLive()) return positionKey(this.boardFen());
    const o = this.outcome();
    const played = this.played();
    // While the opponent's reply is on its way, stay on the position just decided.
    if (!o && this.stage() === 'replying')
      return positionKey(playLine(this.fen(), played.slice(0, -1)));
    if (!o) return positionKey(this.currentFen());
    if (this.explore().length > 0) return positionKey(this.boardFen());
    if (!o.correct) return positionKey(this.currentFen());
    return positionKey(playLine(this.fen(), played.slice(0, -1)));
  });
  protected readonly noteLabel = computed(() => {
    if (!this.atLive()) return 'Your notes on the position on the board';
    const o = this.outcome();
    const played = this.played();
    if (o && this.explore().length > 0) return 'Your notes on the position on the board';
    if (o && !o.correct) return `Your notes on the position where ${o.played} was refused`;
    if (o && played.length > 0) return `Your notes on the position before ${o.played}`;
    if (!o && this.stage() === 'replying' && played.length > 0)
      return `Your notes on the position before ${played[played.length - 1]}`;
    return 'Your notes on this position';
  });

  constructor() {
    void this.openings.load();
    effect(() => {
      const games = this.store.games();
      if (games.length > 0) untracked(() => void this.index.ensure(games));
    });
    // Mistake cards need the mistake report; build it like the Mistakes page does.
    effect(() => {
      if (this.source() === 'repertoire') return;
      const games = this.store.games();
      const link = this.profiles.profile()?.lichess;
      const running = this.finder.running();
      if (games.length === 0 || !link) return;
      untracked(() => {
        if (running || this.finder.isCurrent(games, link.id)) return;
        void this.finder.analyse(games, link.id);
      });
    });
    // Drop the card on the board when a filter change removes it from the set.
    effect(() => {
      const cards = this.cards();
      const current = untracked(() => this.card());
      if (!current) return;
      const id = cardStateId(current);
      if (!cards.some((c) => cardStateId(c) === id)) untracked(() => this.card.set(null));
    });
    // Switching mode restarts the current card unless it is already answered.
    effect(() => {
      this.mode();
      untracked(() => {
        const current = this.card();
        if (current && this.stage() !== 'done') this.show(current);
      });
    });
    // Pick a card whenever there is none on the board and the queue has one.
    effect(() => {
      const q = this.queue();
      if (this.card() !== null) return;
      const next = q.due[0] ?? q.fresh[0] ?? null;
      untracked(() => this.show(next));
    });
    this.destroyRef.onDestroy(() => {
      this.attempt++;
      this.clearReplyTimer();
    });
  }

  private show(card: DrillCard | null): void {
    this.clearReplyTimer();
    this.attempt++;
    this.card.set(card);
    this.stage.set('answer');
    this.played.set([]);
    this.pending.set(null);
    this.expected.set(card?.expected ?? null);
    this.outcome.set(null);
    this.explore.set([]);
    this.cursor.set(null);
    this.thinkMs = 0;
    this.startedAt = Date.now();
  }

  /** Plays a move from the engine panel: an answer before, exploration after. */
  protected playSan(san: string): void {
    try {
      const m = new Chess(this.boardFen()).move(san);
      this.onBoardMove({ from: m.from as Key, to: m.to as Key });
    } catch {
      // Not legal here.
    }
  }

  protected onBoardMove({ from, to }: BoardMove): void {
    const card = this.card();
    if (!card || this.stage() === 'checking' || this.stage() === 'replying') return;
    if (this.outcome()) {
      // Free exploration after the drill ended. From an earlier explored
      // position the move replaces what followed; the drill's own moves and
      // the history stay as they were.
      const san = sanOf(this.boardFen(), from, to);
      if (!san) return;
      const at = this.viewPly() - this.exploreFrom();
      if (at < 0) return;
      this.explore.update((e) => [...e.slice(0, at), san]);
      this.cursor.set(null);
      return;
    }
    if (!this.atLive()) return;
    const fen = this.currentFen();
    const san = sanOf(fen, from, to);
    if (!san) return;
    this.thinkMs += Date.now() - this.startedAt;
    this.stage.set('checking');
    this.pending.set(san);
    const attempt = this.attempt;
    const forbidden = this.played().length === 0 ? card.played : [];
    void this.grader
      .grade(fen, san, this.expected(), forbidden, card.color)
      .catch((): GradeResult => ({ ok: true, reason: 'engine-approved', drop: null, best: null }))
      .then((result) => {
        if (attempt !== this.attempt) return;
        void this.onGraded(card, san, result);
      });
  }

  private async onGraded(card: DrillCard, san: string, result: GradeResult): Promise<void> {
    const before = this.currentFen();
    this.pending.set(null);
    if (!result.ok) {
      this.finish(false, san, result);
      return;
    }
    this.played.update((p) => [...p, san]);
    const solved = this.userMoves();
    if (this.mode() === 'single' || solved >= MAX_SEQUENCE_MOVES) {
      this.finish(true, san, result);
      return;
    }
    this.stage.set('replying');
    const attempt = this.attempt;
    const next = await this.continuation(card, before, san, this.currentFen());
    if (attempt !== this.attempt) return;
    if (!next) {
      this.finish(true, san, result);
      return;
    }
    this.replyTimer = setTimeout(() => {
      this.replyTimer = null;
      if (attempt !== this.attempt) return;
      this.played.update((p) => [...p, next.reply]);
      this.expected.set(next.expected);
      this.stage.set('answer');
      this.startedAt = Date.now();
    }, REPLY_DELAY_MS);
  }

  /**
   * The opponent's automatic reply to the user's move `san` (from `before`
   * to `fen`) and the move to find after it. Repertoire cards follow the
   * user's own games (most common reply, then the habitual answer when there
   * is one); mistake cards follow the engine's line, puzzle style: the stored
   * variation of the position when the user played its first move, else an
   * evaluation of the new position.
   */
  private async continuation(
    card: DrillCard,
    before: string,
    san: string,
    fen: string,
  ): Promise<{ reply: string; expected: string | null } | null> {
    if (new Chess(fen).isGameOver()) return null;
    if (card.kind === 'repertoire') {
      const reply = this.replies().get(positionKey(fen));
      if (!reply) return null;
      const after = playLine(fen, [reply.san]);
      if (after === fen || new Chess(after).isGameOver()) return null;
      return {
        reply: reply.san,
        expected: this.repertoireByKey().get(positionKey(after))?.expected ?? null,
      };
    }
    let line = await this.storedLine(before);
    if (line.length > 0 && uciToSan(before, line[0]) === san) line = line.slice(1);
    else line = await this.engineLine(fen);
    if (line.length < 2) return null;
    const reply = uciToSan(fen, line[0]);
    if (!reply) return null;
    const after = playLine(fen, [reply]);
    if (new Chess(after).isGameOver()) return null;
    const expected = uciToSan(after, line[1]);
    return expected ? { reply, expected } : null;
  }

  /** The principal variation stored for a position, in UCI, or empty. */
  private async storedLine(fen: string): Promise<string[]> {
    const e = (await this.evals.lookupLocal([fen])).get(positionKey(fen));
    return e?.pv ? e.pv.split(' ') : [];
  }

  /** The principal variation of a position, searching when it is not stored yet. */
  private async engineLine(fen: string): Promise<string[]> {
    try {
      const result = await this.evals.getOrEvaluate([fen], this.pool.depth(), 'high');
      const e = result.get(positionKey(fen));
      return e?.pv ? e.pv.split(' ') : [];
    } catch {
      return [];
    }
  }

  private finish(correct: boolean, played: string, result: GradeResult): void {
    this.stage.set('done');
    this.outcome.set({
      correct,
      played,
      seconds: this.thinkMs / 1000,
      solved: this.userMoves(),
      result,
    });
  }

  protected next(): void {
    const card = this.card();
    const outcome = this.outcome();
    if (!card || !outcome) return;
    const perMove = outcome.seconds / Math.max(1, outcome.solved);
    const grade: Grade = !outcome.correct ? 'again' : perMove <= 3 ? 'easy' : 'good';
    void this.drills.record(card, grade);
    this.card.set(null);
  }

  protected skip(): void {
    const card = this.card();
    if (card) {
      const id = cardStateId(card);
      this.drills.skipped.update((s) => new Set(s).add(id));
      this.drills.lastShown.set(id);
    }
    this.card.set(null);
  }

  protected explorerParams(card: DrillCard): { [k: string]: string } {
    return { line: card.line.join(','), color: card.color };
  }

  /** The context line of a mistake card. */
  protected mistakePrompt(c: DrillCard): string {
    const moves =
      c.played.length > 1
        ? `${c.played.slice(0, -1).join(', ')} or ${c.played[c.played.length - 1]}`
        : c.played[0];
    const where =
      c.games > 1 ? `in ${c.games} games` : c.opponent ? `against ${c.opponent}` : 'in a game';
    const what = c.judgement ? `, a ${c.judgement} (${JUDGEMENT_SYMBOL[c.judgement]})` : '';
    return `You played ${moves} here ${where}${what}. Find a better move.`;
  }

  /** The context line of a repertoire card. */
  protected habitPrompt(c: DrillCard): string {
    const share = Math.round(c.share * 100);
    const time = c.avgTimeSec !== null ? `, taking ${formatSeconds(c.avgTimeSec)} on average` : '';
    return `You reached this position ${c.games} times and played the same move in ${share}% of them${time}.`;
  }

  /** Describes why a move was accepted or refused. */
  protected verdict(o: Outcome, card: DrillCard): string {
    const r = o.result;
    const best = r.best && r.best !== o.played ? ` The engine prefers ${r.best}.` : '';
    switch (r.reason) {
      case 'expected':
        return card.kind === 'mistake'
          ? `${o.played} is the engine's move.`
          : `${o.played}, your usual move.`;
      case 'engine-approved':
        return r.drop === null
          ? `${o.played} accepted (no evaluation available to check it).`
          : `${o.played} is fine too: it costs ${r.drop.toFixed(0)} points of winning chance.${best}`;
      case 'known-mistake':
        return `${o.played} is the move you played in the game, a ${card.judgement ?? 'mistake'}.${best}`;
      case 'too-costly':
        return `${o.played} loses ${(r.drop ?? 0).toFixed(0)} points of winning chance.${best}`;
      default:
        return `${o.played} is not a legal move here.`;
    }
  }

  /** Steps to a position of the timeline; the last one is the live end. */
  protected goTo(ply: number): void {
    const last = this.positions().length - 1;
    this.cursor.set(ply >= last ? null : Math.max(0, ply));
  }

  @HostListener('window:keydown', ['$event'])
  protected onKey(event: KeyboardEvent): void {
    if (isTyping(event.target) || !this.card()) return;
    switch (event.key) {
      case 'Enter':
        if (!this.outcome()) return;
        this.next();
        break;
      case 'ArrowLeft':
        this.goTo(this.viewPly() - 1);
        break;
      case 'ArrowRight':
        this.goTo(this.viewPly() + 1);
        break;
      case 'Home':
        this.goTo(0);
        break;
      case 'End':
        this.goTo(this.positions().length - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  private clearReplyTimer(): void {
    if (this.replyTimer !== null) clearTimeout(this.replyTimer);
    this.replyTimer = null;
  }
}

/** True when the key press belongs to a text field, such as the note box. */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** Alternates two lists, keeping each one's order, until both are exhausted. */
function interleave<T>(a: readonly T[], b: readonly T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

/** The FEN after playing `sans` from `fen`; stops at the first illegal move. */
function playLine(fen: string, sans: readonly string[]): string {
  const chess = new Chess(fen);
  for (const san of sans) {
    try {
      chess.move(san);
    } catch {
      break;
    }
  }
  return chess.fen();
}

function sanOf(fen: string, from: Key, to: Key): string | null {
  try {
    return new Chess(fen).move({ from: from as Square, to: to as Square, promotion: 'q' }).san;
  } catch {
    return null;
  }
}

function squaresOf(fen: string, san: string): Key[] | null {
  try {
    const m = new Chess(fen).move(san);
    return [m.from as Key, m.to as Key];
  } catch {
    return null;
  }
}

function uciToSan(fen: string, uci: string): string | null {
  try {
    return new Chess(fen).move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4],
    }).san;
  } catch {
    return null;
  }
}
