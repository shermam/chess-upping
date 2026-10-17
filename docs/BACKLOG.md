# Backlog

Features and improvements to build after the first version. Items are rough
notes, not specifications; each one should be discussed before it is built.

## Engine evaluation in the browser

Run Stockfish (WebAssembly, in a Web Worker) inside the app and record the
evaluation of every position reached in the user's games.

- Keep a separate collection keyed by position so a position is never
  evaluated twice: `positions/{fenKey}` with `{ eval, depth, bestMove, pv,
engine, evaluatedAt }`. The key should be the FEN without the move counters
  (piece placement, side to move, castling rights, en passant square), so the
  same position reached by different move orders shares one record. FEN
  strings contain `/`, so the key needs an encoding that is safe as a
  Firestore document id (for example a hash, or replacing `/` with `_`).
- Mirror the table in IndexedDB like games, and sync it both ways.
- When walking through a game, look up the resulting position after each move
  and show the stored eval; queue the position for evaluation if missing.
- Only re-evaluate when a higher depth is requested than the stored one.
- Background evaluation of all positions from recent games, respecting
  battery and CPU (idle callbacks, a cap on concurrent workers).
- Evaluations are expensive to compute and public by nature, so they belong
  in a shared collection like games, with rules allowing any signed-in user to
  write a record that passes shape checks.

## Opening tree

- Transposition-aware tree: today nodes are move sequences (like
  openingtree.com); merging by position would combine transpositions.
- Choose the promotion piece when a promotion is played on the board (queen
  is assumed now).
- Show the opening name from Lichess's ECO data when no game at the node
  carries one.
- Sort options for the move table (by games, by score, by last played).
- Date range filter, and opponent rating range filter.
- Highlight moves whose score is poor compared with the alternatives.
- Compare "my games" against the Lichess masters or Lichess player database at
  the same position (Lichess opening explorer API).

## Sync and data

- Server-verified Lichess link. Today a client writes its own Lichess id into
  its profile, so the rules cannot stop a signed-in user from uploading a game
  for any player. A Cloud Function (Blaze plan) could verify the OAuth token
  against Lichess and set the id as a custom claim, which rules can trust;
  then `games` writes could require the claim to be one of the players.
- Correspondence games that were created more than the overlap window (14
  days) before they finished are still missed by the `since` cursor, which is
  based on creation time. Keep a second pass by `lastMoveAt`, or re-query
  ongoing games at link time.
- A "previous account" with hundreds of thousands of games would exceed the
  Spark plan's 20k Firestore writes per day on the first upload. The upload
  already resumes across days; if that becomes a real use case, consider
  storing games in chunked documents (hundreds of games per document) to cut
  writes and reads by two orders of magnitude.
- Support more than one Lichess account per user.
- Chess.com import (public PGN archives API).
- Periodic background sync (service worker / periodic sync API) and a PWA
  manifest so the app installs and works offline.
- Sync status page with per-stage counts and a retry button.

## Study features

- Per-user annotations on positions and games (private, under `users/{uid}`).
- Mistake finder: positions where the stored engine eval drops sharply after
  the user's move, grouped by opening.
- Spaced-repetition drills built from the user's own opening lines.
- Game viewer with move list, eval bar and navigation (shared with the tree).

## Engineering

- Firestore rules unit tests with `@firebase/rules-unit-testing`.
- End-to-end tests against the emulators (Playwright), including the sign-in
  flow with the Auth emulator and a seeded games collection.
- Error reporting for sync failures beyond the toolbar label.
- Content-Security-Policy header on Hosting once the set of external hosts is
  stable (Google fonts, lichess.org, Firebase endpoints).
