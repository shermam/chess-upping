import { describe, expect, it } from 'vitest';
import { lichessSince } from './sync.service';

const DAY = 24 * 60 * 60 * 1000;

describe('lichessSince', () => {
  const now = 100 * DAY;

  it('requests everything on the first sync', () => {
    expect(lichessSince(0, now)).toBe(0);
  });

  it('re-requests a window before the newest game to catch late finishes', () => {
    expect(lichessSince(now - DAY, now)).toBe(now - 14 * DAY);
  });

  it('starts right after an old cursor when it is outside the window', () => {
    expect(lichessSince(now - 30 * DAY, now)).toBe(now - 30 * DAY + 1);
  });
});
