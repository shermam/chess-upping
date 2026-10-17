# Backlog

Features and improvements to build after the first version. Items are rough
notes, not specifications; each one should be discussed before it is built.

## Engine evaluation (built; follow-ups)

The first version is in: Stockfish in Web Workers, a position-keyed table in
IndexedDB and Firestore, the game viewer, and the bulk job on the Engine page.
Still to do:

- Eval graph over the game (cp clipped to a few pawns, mate as the extreme).
- Move classification (inaccuracy, mistake, blunder) from the eval drop after
  each move, and a per-game accuracy figure.
- Mistake finder across all games, grouped by opening and by position.
- Respect battery and CPU: pause the bulk job on battery, use idle callbacks.
- Multi-threaded engine (needs COOP/COEP headers, which conflicts with the
  Google sign-in popup; would require the redirect sign-in flow).
- Multiple principal variations in the viewer.
- Background sync of positions from the cloud for devices that did not
  evaluate them (today lookups are per game, on demand).

## Opening tree

Done: transposition-aware tree, promotion piece choice, ECO opening names by
position, sort options, result / date / opponent rating filters, score
highlighting, Lichess masters and player database comparison, engine eval
bar per move, average thinking time per move.

- Remember filter choices between visits.
- Show the user's own line as a repertoire tree (collapsed view of the most
  played continuations several moves deep).
- Rating buckets for the Lichess player database comparison (today it uses
  the user's time-control filter and all ratings).

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
