import { Injectable, computed, effect, signal } from '@angular/core';
import { positionFen, sideToMove } from '../../models/position-eval';
import { UciInfo, parseBestMove, parseInfo } from './uci';

/** One principal variation from the live analysis, scores from White's side. */
export interface LiveLine {
  rank: number;
  depth: number;
  cp: number | null;
  mate: number | null;
  /** UCI moves. */
  pv: string[];
}

const ENGINE_URL = '/engine/stockfish-19-lite-single.js';
const SETTINGS_KEY = 'live-engine';
/** Search stops by itself at this depth; the lite engine gets there in a few seconds. */
const MAX_DEPTH = 40;
export const MULTI_PV_OPTIONS = [1, 2, 3, 4, 5] as const;

interface Search {
  id: number;
  fen: string;
  lines: Map<number, LiveLine>;
}

function loadSettings(): { enabled: boolean; multiPv: number } {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<{ enabled: boolean; multiPv: number }>;
      return { enabled: parsed.enabled ?? false, multiPv: parsed.multiPv ?? 1 };
    }
  } catch {
    // Storage unavailable.
  }
  return { enabled: false, multiPv: 1 };
}

/**
 * Lichess-style live analysis: one dedicated Stockfish worker that keeps
 * searching whatever position is on screen and streams its best lines. The
 * switch and the number of lines are remembered per device. Only one position
 * is analysed at a time; the most recent request wins.
 */
@Injectable({ providedIn: 'root' })
export class LiveEngineService {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private waitingFor: string | null = null;
  private current: Search | null = null;
  private pending: string | null = null;
  /** True after `stop` was sent for `current`, until its bestmove arrives. */
  private stopping = false;
  private nextId = 1;
  private appliedMultiPv = 0;

  readonly enabled = signal(loadSettings().enabled);
  readonly multiPv = signal(loadSettings().multiPv);
  /** The position requested for analysis (full FEN), or null when no board is shown. */
  readonly fen = signal<string | null>(null);
  /** The position the current lines belong to; lags `fen` until the new search starts. */
  readonly searchFen = signal<string | null>(null);
  readonly lines = signal<LiveLine[]>([]);
  /** True when the analysed position has no legal moves (mate or stalemate). */
  readonly terminal = signal(false);
  readonly depth = signal(0);
  readonly searching = signal(false);
  readonly error = signal<string | null>(null);
  readonly supported = typeof Worker !== 'undefined';
  readonly best = computed(() => this.lines()[0] ?? null);

  constructor() {
    effect(() => {
      const settings = { enabled: this.enabled(), multiPv: this.multiPv() };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch {
        // Ignore storage failures.
      }
    });
    // Restart the search when the number of lines changes.
    effect(() => {
      this.multiPv();
      const fen = this.fen();
      if (fen && this.enabled()) this.start(fen);
    });
  }

  toggle(): void {
    this.enabled.update((v) => !v);
    const fen = this.fen();
    if (!this.enabled()) this.stop();
    else if (fen) this.start(fen);
  }

  /** Analyse `fen` (when enabled); pass null when no board is on screen. */
  setPosition(fen: string | null): void {
    if (fen !== this.fen()) {
      // Old lines must never be read as this position's.
      this.lines.set([]);
      this.depth.set(0);
      this.terminal.set(false);
      this.searchFen.set(null);
    }
    this.fen.set(fen);
    if (!fen) {
      this.stop();
      return;
    }
    if (this.enabled()) this.start(fen);
  }

  private ensureWorker(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
      try {
        this.worker = new Worker(ENGINE_URL);
      } catch (err) {
        this.error.set(err instanceof Error ? err.message : String(err));
        resolve();
        return;
      }
      this.worker.onmessage = (ev: MessageEvent<unknown>) => this.onLine(String(ev.data).trim());
      this.worker.onerror = (ev) => {
        this.error.set(`Engine worker error: ${ev.message || 'unknown'}`);
        // Forget the dead worker entirely; the next request boots a fresh one
        // with default options.
        this.worker = null;
        this.ready = null;
        this.current = null;
        this.pending = null;
        this.stopping = false;
        this.appliedMultiPv = 0;
        this.searching.set(false);
      };
      this.waitingFor = 'uciok';
      this.worker.postMessage('uci');
    });
    return this.ready;
  }

  private send(cmd: string): void {
    this.worker?.postMessage(cmd);
  }

  private start(fen: string): void {
    const sameSearch =
      this.current !== null &&
      this.current.fen === fen &&
      this.appliedMultiPv === this.multiPv() &&
      !this.stopping;
    if (sameSearch) return;
    void this.ensureWorker().then(() => {
      // The world may have moved on while the worker booted.
      if (!this.worker || !this.enabled() || this.fen() !== fen) return;
      if (this.current) {
        // Let the running search finish on `stop`; its bestmove starts the next one.
        this.pending = fen;
        if (!this.stopping) {
          this.stopping = true;
          this.send('stop');
        }
        return;
      }
      this.launch(fen);
    });
  }

  private launch(fen: string): void {
    const multiPv = this.multiPv();
    if (this.appliedMultiPv !== multiPv) {
      this.send(`setoption name MultiPV value ${multiPv}`);
      this.appliedMultiPv = multiPv;
    }
    this.current = { id: this.nextId++, fen, lines: new Map() };
    this.stopping = false;
    this.lines.set([]);
    this.depth.set(0);
    this.terminal.set(false);
    this.searchFen.set(fen);
    this.searching.set(true);
    this.send(`position fen ${positionFen(fen)} 0 1`);
    this.send(`go depth ${MAX_DEPTH}`);
  }

  stop(): void {
    this.pending = null;
    if (this.current && !this.stopping) {
      this.stopping = true;
      this.send('stop');
    }
  }

  private onLine(line: string): void {
    if (this.waitingFor && line === this.waitingFor) {
      if (line === 'uciok') {
        this.waitingFor = 'readyok';
        this.send('setoption name Hash value 64');
        this.send('isready');
        return;
      }
      this.waitingFor = null;
      this.error.set(null);
      this.readyResolve?.();
      return;
    }
    const search = this.current;
    if (!search) return;
    const info = parseInfo(line);
    if (info) {
      this.record(search, info);
      return;
    }
    const best = parseBestMove(line);
    if (best) {
      // No move at all: the position is mate or stalemate.
      if (best.bestMove === null && search.lines.size === 0 && !this.stopping)
        this.terminal.set(true);
      this.current = null;
      this.stopping = false;
      this.searching.set(false);
      const next = this.pending;
      this.pending = null;
      if (next && this.enabled() && this.fen() === next) this.launch(next);
    }
  }

  private record(search: Search, info: UciInfo): void {
    if (info.pv.length === 0) return;
    const black = sideToMove(search.fen) === 'black';
    search.lines.set(info.multipv, {
      rank: info.multipv,
      depth: info.depth,
      cp: info.cp === null ? null : black ? -info.cp : info.cp,
      mate: info.mate === null ? null : black ? -info.mate : info.mate,
      pv: info.pv,
    });
    this.lines.set([...search.lines.values()].sort((a, b) => a.rank - b.rank));
    if (info.multipv === 1) this.depth.set(info.depth);
  }
}
