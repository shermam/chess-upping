import { Game, GamePlayer } from './game';

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isNullOr<T>(x: unknown, check: (v: unknown) => v is T): x is T | null {
  return x === null || check(x);
}

const isString = (x: unknown): x is string => typeof x === 'string';
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function isPlayer(x: unknown): x is GamePlayer {
  return (
    isRecord(x) &&
    isString(x['name']) &&
    isNullOr(x['id'], isString) &&
    isNullOr(x['rating'], isNumber) &&
    isNullOr(x['ratingDiff'], isNumber)
  );
}

/**
 * Checks that a value read from Firestore has the shape the app relies on.
 * The security rules enforce the same shape on write, but a document that
 * slipped through (older rules, a bug) must not be able to break every screen
 * once it is copied into the local store.
 */
export function isValidGame(x: unknown): x is Game {
  if (!isRecord(x)) return false;
  const players = x['players'];
  return (
    isString(x['id']) &&
    typeof x['rated'] === 'boolean' &&
    x['variant'] === 'standard' &&
    isString(x['speed']) &&
    isString(x['perf']) &&
    isNumber(x['createdAt']) &&
    isNumber(x['lastMoveAt']) &&
    isString(x['status']) &&
    (x['winner'] === null || x['winner'] === 'white' || x['winner'] === 'black') &&
    Array.isArray(players) &&
    players.length >= 1 &&
    players.length <= 2 &&
    players.every(isString) &&
    isPlayer(x['white']) &&
    isPlayer(x['black']) &&
    isString(x['moves']) &&
    x['moves'].length > 0 &&
    (x['opening'] === null ||
      (isRecord(x['opening']) &&
        isString(x['opening']['eco']) &&
        isString(x['opening']['name']) &&
        isNumber(x['opening']['ply']))) &&
    (x['clock'] === null ||
      (isRecord(x['clock']) &&
        isNumber(x['clock']['initial']) &&
        isNumber(x['clock']['increment']))) &&
    isNullOr(x['source'], isString)
  );
}

/** Returns a `Game` with only the fields the app stores, or null if invalid. */
export function toGame(x: unknown): Game | null {
  if (!isValidGame(x)) return null;
  return {
    id: x.id,
    rated: x.rated,
    variant: x.variant,
    speed: x.speed,
    perf: x.perf,
    createdAt: x.createdAt,
    lastMoveAt: x.lastMoveAt,
    status: x.status,
    winner: x.winner,
    players: x.players,
    white: x.white,
    black: x.black,
    moves: x.moves,
    opening: x.opening,
    clock: x.clock,
    source: x.source,
  };
}
