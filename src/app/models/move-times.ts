import { Game } from './game';

/**
 * Seconds each ply took, derived from the Lichess clock readings: the time
 * left before the move (the mover's previous reading) plus the increment,
 * minus the time left after it. Lichess does not run the clocks during the
 * first move of each side, so those two plies are null, as is any ply
 * without clock data.
 */
export function moveTimes(game: Game): (number | null)[] {
  const plies = game.moves ? game.moves.split(' ').length : 0;
  const { clocks, clock } = game;
  const out: (number | null)[] = new Array<number | null>(plies).fill(null);
  if (!clocks || !clock) return out;
  const increment = clock.increment * 100;
  for (let i = 2; i < plies && i < clocks.length; i++) {
    const spent = clocks[i - 2] + increment - clocks[i];
    out[i] = spent >= 0 ? spent / 100 : null;
  }
  return out;
}

/** Formats seconds for a table cell: `0.8s`, `12s`, `1m05`. */
export function formatSeconds(seconds: number): string {
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}m${String(s).padStart(2, '0')}`;
}
