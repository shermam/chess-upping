/** Spaced-repetition state for one drill card (SM-2 style). */
export interface DrillState {
  key: string;
  ease: number;
  intervalDays: number;
  /** Epoch ms when the card is next due. */
  due: number;
  reps: number;
  lapses: number;
  lastReviewed: number;
}

export type Grade = 'again' | 'good' | 'easy';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A failed card comes back within the session. */
const RETRY_MS = 10 * 60 * 1000;

export function review(
  previous: DrillState | null,
  key: string,
  grade: Grade,
  now: number,
): DrillState {
  const prev = previous ?? {
    key,
    ease: 2.5,
    intervalDays: 0,
    due: now,
    reps: 0,
    lapses: 0,
    lastReviewed: 0,
  };
  if (grade === 'again') {
    return {
      ...prev,
      key,
      ease: Math.max(1.3, prev.ease - 0.2),
      intervalDays: 0,
      reps: 0,
      lapses: prev.lapses + 1,
      due: now + RETRY_MS,
      lastReviewed: now,
    };
  }
  const reps = prev.reps + 1;
  let interval: number;
  if (reps === 1) interval = 1;
  else if (reps === 2) interval = 6;
  else interval = Math.round(prev.intervalDays * prev.ease);
  const ease = grade === 'easy' ? prev.ease + 0.15 : prev.ease;
  if (grade === 'easy') interval = Math.round(interval * 1.3);
  return {
    ...prev,
    key,
    ease,
    intervalDays: Math.max(1, interval),
    reps,
    due: now + Math.max(1, interval) * DAY_MS,
    lastReviewed: now,
  };
}
