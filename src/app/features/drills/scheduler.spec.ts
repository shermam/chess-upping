import { describe, expect, it } from 'vitest';
import { review } from './scheduler';

const DAY = 24 * 60 * 60 * 1000;

describe('review', () => {
  it('grows the interval on good answers', () => {
    const now = 1_000_000;
    const first = review(null, 'k', 'good', now);
    expect(first.intervalDays).toBe(1);
    expect(first.due).toBe(now + DAY);
    const second = review(first, 'k', 'good', first.due);
    expect(second.intervalDays).toBe(6);
    const third = review(second, 'k', 'good', second.due);
    expect(third.intervalDays).toBe(15);
    expect(third.reps).toBe(3);
  });

  it('resets on a lapse and retries soon', () => {
    const now = 1_000_000;
    const good = review(review(null, 'k', 'good', now), 'k', 'good', now + DAY);
    const failed = review(good, 'k', 'again', now + 7 * DAY);
    expect(failed.reps).toBe(0);
    expect(failed.lapses).toBe(1);
    expect(failed.ease).toBeCloseTo(2.3);
    expect(failed.due - (now + 7 * DAY)).toBe(10 * 60 * 1000);
  });

  it('easy answers lengthen the interval and raise ease', () => {
    const now = 0;
    const easy = review(null, 'k', 'easy', now);
    expect(easy.ease).toBeCloseTo(2.65);
    expect(easy.intervalDays).toBe(1);
  });
});
