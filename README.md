# Chess Upping

A personal chess-improvement app. Sign in with Google, connect a Lichess
account, and the app downloads every standard game you have played, keeps a
copy in your browser, and lets you explore your own games like an opening
book, in the style of openingtree.com.

Live site: https://chess-upping.web.app

## How it works

- **Angular 22** (standalone components, signals, zoneless) with Angular Material.
- **Firebase Auth** (Google) identifies users. **Firestore** holds a private
  `users/{uid}` document per user and one shared, public `games` collection.
  The document id of a game is its Lichess id, so a game played between two
  users of the app is stored once.
- **Lichess OAuth (PKCE)** runs entirely in the browser. No app registration or
  client secret is needed. The token is kept on the user's own profile document,
  readable only by that user, so a link made on one device works on all.
- **Local first.** Games live in IndexedDB (via Dexie). Every screen reads from
  memory and IndexedDB; the network is only used to sync. A sync pulls games
  newer than the last pull from Firestore, streams newer games from Lichess at
  60 games/second, saves them locally, then uploads them to Firestore in
  batches. Anything not uploaded (quota, offline) is retried next time.
- **Opening tree.** Games are filtered by colour, time control and rated/casual,
  then aggregated by move sequence at each node: game counts, win/draw/loss,
  average opponent rating, last played, and the games that reached the position.
- **Firebase config** is never committed. The app fetches it at runtime from
  Hosting's reserved `/__/firebase/init.json`.

## Project layout

```
src/app/core/firebase     Firebase initialisation from init.json (and emulators)
src/app/core/auth         Google sign-in, route guard, user profile document
src/app/core/lichess      OAuth PKCE, Lichess API client, NDJSON game parsing
src/app/core/data         IndexedDB store, Firestore games repository, sync
src/app/features          Pages: opening tree (with board), login, Lichess callback
firestore.rules           Security rules; firestore.indexes.json the composite index
.github/workflows         CI, preview channels on PRs, live deploy on main
docs/BACKLOG.md           Features to build next
```

## Development

Requires Node 24.

```sh
npm install
npm start          # ng serve on http://localhost:4200
```

`npm start` proxies `/__/firebase/init.json` to the production Hosting site
(see `proxy.conf.json`), so the dev server talks to the real project. Google
sign-in works on localhost because Firebase authorizes it by default.

To work fully offline against the Firebase emulators instead:

```sh
npm run build
npx firebase emulators:start   # app on http://localhost:5000
```

When the app runs on localhost and finds the Emulator Hub on port 4400, it
connects Auth and Firestore to the running emulators automatically (this also
applies to `npm start` while the emulators are up). This needs Java for the Firestore emulator and credentials that can read the
project's web app config (`GOOGLE_APPLICATION_CREDENTIALS` pointing at a
service account key, or `firebase login`).

Other scripts:

```sh
npm test               # unit tests (vitest)
npm run format         # prettier
npm run build          # production build into dist/chess-upping/browser
```

## Deployment

Pushing to `main` runs `.github/workflows/deploy.yml`, which deploys Firestore
rules and indexes, then Hosting. Pull requests get a temporary preview channel
(`.github/workflows/preview.yml`). Both use the
`FIREBASE_SERVICE_ACCOUNT_CHESS_UPPING` repository secret.

The service account needs these IAM roles on the project for the workflows
to succeed (the default `firebase-adminsdk` account has only some of them):

- Firebase Hosting Admin (`roles/firebasehosting.admin`)
- Firebase Rules Admin (`roles/firebaserules.admin`)
- Cloud Datastore Index Admin (`roles/datastore.indexAdmin`)
- Service Usage Consumer (`roles/serviceusage.serviceUsageConsumer`)

Granting the broader Firebase Admin role (`roles/firebase.admin`) also works.
Without the index role, the composite index in `firestore.indexes.json` can
be created by hand in the Firebase console; the app still works without it
but cannot pull games uploaded from other devices.

Google sign-in only works on domains listed under Authentication > Settings >
Authorized domains in the Firebase console. `chess-upping.web.app`,
`chess-upping.firebaseapp.com` and `localhost` are there by default; a preview
channel host has to be added by hand if you want to sign in on it.

## Data model

`users/{uid}` (private to the user)

```
email, displayName, updatedAt
lichess: { id, username, token, linkedAt }
```

`games/{lichessGameId}` (public, readable by any signed-in user)

```
id, rated, variant ('standard'), speed, perf, createdAt, lastMoveAt, status,
winner ('white' | 'black' | null), players [lichess ids of the human players],
white { name, id, rating, ratingDiff }, black { ... },
moves 'e4 e5 Nf3 ...', opening { eco, name, ply } | null,
clock { initial, increment } | null, source
```

A game can be created or updated only by a signed-in user whose linked Lichess
id is one of its players, and never deleted.
