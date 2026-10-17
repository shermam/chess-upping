import { Injectable, inject, signal } from '@angular/core';
import { Chess } from 'chess.js';
import { Judgement, judgeMoves } from '../../models/analysis';
import { Color, Game } from '../../models/game';
import { OpeningsService } from '../openings/openings.service';
import { LocalDbService } from './local-db.service';
import { gameKeys } from './position-index.service';

export interface Mistake {
  game: Game;
  /** 1-based ply of the user's move. */
  ply: number;
  san: string;
  color: Color;
  drop: number;
  judgement: Judgement;
  bestMove: string | null;
  /** The engine's move in SAN, resolved once here. */
  bestSan: string | null;
  /** Position key before the move, for grouping repeated errors. */
  keyBefore: string;
  /** The moves played up to (not including) the mistake, for linking into the explorer. */
  lineBefore: string[];
  opening: string;
}

export interface MistakeReport {
  /** Identifies the games the report was computed from. */
  fingerprint: string;
  lichessId: string;
  mistakes: Mistake[];
  /** User moves that had evaluations on both sides, per colour. */
  judgedMoves: { white: number; black: number };
  gamesAnalysed: number;
  gamesWithoutEvals: number;
}

/**
 * Finds the user's inaccuracies, mistakes and blunders across all games from
 * the stored engine evaluations. Runs entirely on local data (a replay of
 * each game plus the local evaluation table), so it costs no network and a
 * few seconds of work for thousands of games.
 */
@Injectable({ providedIn: 'root' })
export class MistakeFinderService {
  private readonly db = inject(LocalDbService);
  private readonly openings = inject(OpeningsService);

  private generation = 0;

  readonly progress = signal(0);
  readonly running = signal(false);
  readonly report = signal<MistakeReport | null>(null);

  /** Cheap identity of a games list: count plus newest and oldest ids. */
  static fingerprint(games: readonly Game[], lichessId: string): string {
    return `${lichessId}:${games.length}:${games[0]?.id ?? ''}:${games[games.length - 1]?.id ?? ''}`;
  }

  /** True when the current report already covers these games. */
  isCurrent(games: readonly Game[], lichessId: string): boolean {
    return this.report()?.fingerprint === MistakeFinderService.fingerprint(games, lichessId);
  }

  async analyse(games: readonly Game[], lichessId: string): Promise<MistakeReport | null> {
    const generation = ++this.generation;
    this.running.set(true);
    this.progress.set(0);
    try {
      await this.openings.load();
      const mistakes: Mistake[] = [];
      const judgedMoves = { white: 0, black: 0 };
      let gamesAnalysed = 0;
      let gamesWithoutEvals = 0;
      for (let i = 0; i < games.length; i++) {
        const game = games[i];
        const color: Color | null =
          game.white.id === lichessId ? 'white' : game.black.id === lichessId ? 'black' : null;
        if (!color) continue;
        // Replay the whole game: the shared position index stops at the opening.
        const keys = gameKeys(game);
        const evals = await this.db.getPositions(keys);
        if (evals.size === 0) {
          gamesWithoutEvals++;
          continue;
        }
        gamesAnalysed++;
        const sans = game.moves.split(' ');
        const plies = keys.map((key, p) => ({
          key,
          fen: fenSide(key),
          san: p === 0 ? null : (sans[p - 1] ?? null),
        }));
        const judged = judgeMoves(plies, evals).filter((m) => m.color === color);
        judgedMoves[color] += judged.length;
        for (const m of judged) {
          if (!m.judgement) continue;
          const lineBefore = sans.slice(0, m.ply - 1);
          const opening = this.openings.nameForKeys(keys.slice(0, m.ply));
          mistakes.push({
            game,
            ply: m.ply,
            san: m.san,
            color,
            drop: m.drop,
            judgement: m.judgement,
            bestMove: m.bestMove,
            bestSan: bestSan(keys[m.ply - 1], m.bestMove),
            keyBefore: keys[m.ply - 1],
            lineBefore,
            opening: opening ? `${opening.eco} ${opening.name}` : 'Unknown opening',
          });
        }
        if (i % 25 === 0) {
          this.progress.set((i / games.length) * 100);
          await new Promise((r) => setTimeout(r, 0));
          // A newer run has started: let it own the result.
          if (generation !== this.generation) return null;
        }
      }
      const report: MistakeReport = {
        fingerprint: MistakeFinderService.fingerprint(games, lichessId),
        lichessId,
        mistakes,
        judgedMoves,
        gamesAnalysed,
        gamesWithoutEvals,
      };
      this.report.set(report);
      this.progress.set(100);
      return report;
    } finally {
      if (generation === this.generation) this.running.set(false);
    }
  }
}

/** SAN of a UCI move from the position `key`, or null when it cannot be played. */
function bestSan(key: string, uci: string | null): string | null {
  if (!uci) return null;
  try {
    const chess = new Chess(`${key.replace(/_/g, '/')} 0 1`);
    return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch {
    return null;
  }
}

/** `judgeMoves` only needs the side to move from the FEN; a key carries it in the same place. */
function fenSide(key: string): string {
  return key.replace(/_/g, '/');
}
