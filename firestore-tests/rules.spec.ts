import {
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

let env: RulesTestEnvironment;

const ALICE = 'alice-uid';
const BOB = 'bob-uid';

function game(overrides: Record<string, unknown> = {}) {
  return {
    id: 'game0001',
    rated: true,
    variant: 'standard',
    speed: 'blitz',
    perf: 'blitz',
    createdAt: 1700000000000,
    lastMoveAt: 1700000600000,
    status: 'mate',
    winner: 'white',
    players: ['alice', 'bob'],
    white: { name: 'Alice', id: 'alice', rating: 1500, ratingDiff: 8 },
    black: { name: 'Bob', id: 'bob', rating: 1520, ratingDiff: -8 },
    moves: 'e4 e5 Nf3 Nc6',
    opening: { eco: 'C44', name: "King's Knight Opening", ply: 4 },
    clock: { initial: 300, increment: 3 },
    source: 'pool',
    clocks: [30000, 30000, 29800, 29500],
    uploadedBy: ALICE,
    uploadedAt: serverTimestamp(),
    ...overrides,
  };
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-chess-upping-rules',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});

beforeEach(() => env.clearFirestore());
afterAll(() => env.cleanup());

describe('users/{uid}', () => {
  it('is readable and writable only by its owner', async () => {
    const alice = env.authenticatedContext(ALICE).firestore();
    const bob = env.authenticatedContext(BOB).firestore();
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(setDoc(doc(alice, 'users', ALICE), { email: 'a@example.com' }));
    await assertSucceeds(getDoc(doc(alice, 'users', ALICE)));
    await assertFails(getDoc(doc(bob, 'users', ALICE)));
    await assertFails(setDoc(doc(bob, 'users', ALICE), { lichess: { id: 'x' } }));
    await assertFails(getDoc(doc(anon, 'users', ALICE)));
  });
});

describe('users/{uid}/notes', () => {
  it('is private to the owner', async () => {
    const alice = env.authenticatedContext(ALICE).firestore();
    const bob = env.authenticatedContext(BOB).firestore();
    await assertSucceeds(
      setDoc(doc(alice, 'users', ALICE, 'notes', 'p:x'), {
        kind: 'position',
        target: 'x',
        text: 'hi',
      }),
    );
    await assertSucceeds(getDoc(doc(alice, 'users', ALICE, 'notes', 'p:x')));
    await assertFails(getDoc(doc(bob, 'users', ALICE, 'notes', 'p:x')));
    await assertFails(setDoc(doc(bob, 'users', ALICE, 'notes', 'p:y'), { text: 'no' }));
  });
});

describe('games/{id}', () => {
  it('lets a signed-in user create a well-formed game once, and anyone signed in read it', async () => {
    const alice = env.authenticatedContext(ALICE).firestore();
    const bob = env.authenticatedContext(BOB).firestore();
    await assertSucceeds(setDoc(doc(alice, 'games', 'game0001'), game()));
    await assertSucceeds(getDoc(doc(bob, 'games', 'game0001')));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'games', 'game0001')));
    // Immutable: neither player can change or re-create it.
    await assertFails(setDoc(doc(bob, 'games', 'game0001'), game({ uploadedBy: BOB })));
    await assertFails(setDoc(doc(alice, 'games', 'game0001'), game({ winner: 'black' })));
  });

  it('allows adding clocks to a game stored without them, and nothing else', async () => {
    const alice = env.authenticatedContext(ALICE).firestore();
    const bob = env.authenticatedContext(BOB).firestore();
    await assertSucceeds(setDoc(doc(alice, 'games', 'game0001'), game({ clocks: null })));
    const stamp = { uploadedBy: BOB, uploadedAt: serverTimestamp() };
    await assertFails(
      updateDoc(doc(bob, 'games', 'game0001'), { clocks: [1, 2], winner: 'black', ...stamp }),
    );
    await assertFails(updateDoc(doc(bob, 'games', 'game0001'), { clocks: 'x', ...stamp }));
    await assertFails(updateDoc(doc(bob, 'games', 'game0001'), { clocks: [], ...stamp }));
    await assertFails(updateDoc(doc(bob, 'games', 'game0001'), { clocks: ['a', 'b'], ...stamp }));
    await assertFails(
      updateDoc(doc(bob, 'games', 'game0001'), {
        clocks: [1, 2],
        uploadedBy: ALICE,
        uploadedAt: serverTimestamp(),
      }),
    );
    await assertSucceeds(updateDoc(doc(bob, 'games', 'game0001'), { clocks: [1, 2], ...stamp }));
    // Once present, clocks are final.
    await assertFails(
      updateDoc(doc(alice, 'games', 'game0001'), {
        clocks: [3, 4],
        uploadedBy: ALICE,
        uploadedAt: serverTimestamp(),
      }),
    );
  });

  it('accepts a full batch of 500 games', async () => {
    const alice = env.authenticatedContext(ALICE).firestore();
    const batch = writeBatch(alice);
    for (let i = 0; i < 500; i++) {
      const id = `batch${String(i).padStart(4, '0')}`;
      batch.set(doc(alice, 'games', id), game({ id }));
    }
    await assertSucceeds(batch.commit());
  });

  it('accepts games against the computer or anonymous players', async () => {
    const alice = env.authenticatedContext(ALICE).firestore();
    await assertSucceeds(
      setDoc(
        doc(alice, 'games', 'game0001'),
        game({
          players: ['alice'],
          black: { name: 'Stockfish level 3', id: null, rating: null, ratingDiff: null },
          winner: null,
          opening: null,
          clock: null,
          source: null,
        }),
      ),
    );
  });

  it('rejects malformed games', async () => {
    const alice = env.authenticatedContext(ALICE).firestore();
    const ref = doc(alice, 'games', 'game0001');
    await assertFails(setDoc(ref, game({ id: 'other' })));
    await assertFails(setDoc(ref, game({ variant: 'chess960' })));
    await assertFails(setDoc(ref, game({ players: [] })));
    await assertFails(setDoc(ref, game({ players: [1, 2] })));
    await assertFails(setDoc(ref, game({ players: ['a', 'b', 'c'] })));
    await assertFails(setDoc(ref, game({ winner: 'draw' })));
    await assertFails(setDoc(ref, game({ moves: '' })));
    await assertFails(setDoc(ref, game({ white: { name: 'Alice' } })));
    await assertFails(
      setDoc(ref, game({ white: { name: 'Alice', id: 7, rating: null, ratingDiff: null } })),
    );
    await assertFails(setDoc(ref, game({ opening: { eco: 'C44' } })));
    const { white: _white, ...noWhite } = game();
    await assertFails(setDoc(ref, noWhite));
  });

  it('requires the uploader fields to be truthful', async () => {
    const alice = env.authenticatedContext(ALICE).firestore();
    const ref = doc(alice, 'games', 'game0001');
    await assertFails(setDoc(ref, game({ uploadedBy: BOB })));
    await assertFails(setDoc(ref, game({ uploadedAt: new Date() })));
    const { uploadedAt: _at, ...noTimestamp } = game();
    await assertFails(setDoc(ref, noTimestamp));
    await assertFails(
      setDoc(doc(env.unauthenticatedContext().firestore(), 'games', 'game0001'), game()),
    );
  });
});

describe('positions/{key}', () => {
  const KEY = 'rnbqkbnr_pppppppp_8_8_4P3_8_PPPP1PPP_RNBQKBNR b KQkq -';
  function evaluation(uid: string, overrides: Record<string, unknown> = {}) {
    return {
      key: KEY,
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -',
      cp: 30,
      mate: null,
      depth: 16,
      bestMove: 'e7e5',
      pv: 'e7e5 g1f3 b8c6',
      engine: 'stockfish-19-lite',
      nodes: 150000,
      evaluatedAt: 1700000000000,
      uploadedBy: uid,
      uploadedAt: serverTimestamp(),
      ...overrides,
    };
  }

  it('lets signed-in users create and read evaluations', async () => {
    const alice = env.authenticatedContext(ALICE).firestore();
    const bob = env.authenticatedContext(BOB).firestore();
    await assertSucceeds(setDoc(doc(alice, 'positions', KEY), evaluation(ALICE)));
    await assertSucceeds(getDoc(doc(bob, 'positions', KEY)));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'positions', KEY)));
    await assertFails(
      setDoc(doc(env.unauthenticatedContext().firestore(), 'positions', 'other'), evaluation('x')),
    );
  });

  it('replaces an evaluation only with a deeper one', async () => {
    const alice = env.authenticatedContext(ALICE).firestore();
    const bob = env.authenticatedContext(BOB).firestore();
    await assertSucceeds(setDoc(doc(alice, 'positions', KEY), evaluation(ALICE, { depth: 16 })));
    await assertFails(setDoc(doc(bob, 'positions', KEY), evaluation(BOB, { depth: 16 })));
    await assertFails(setDoc(doc(bob, 'positions', KEY), evaluation(BOB, { depth: 12 })));
    await assertSucceeds(setDoc(doc(bob, 'positions', KEY), evaluation(BOB, { depth: 20 })));
  });

  it('rejects malformed evaluations', async () => {
    const alice = env.authenticatedContext(ALICE).firestore();
    const ref = doc(alice, 'positions', KEY);
    await assertFails(setDoc(ref, evaluation(ALICE, { key: 'other' })));
    await assertFails(setDoc(ref, evaluation(ALICE, { cp: null })));
    await assertFails(setDoc(ref, evaluation(ALICE, { cp: '30' })));
    await assertFails(setDoc(ref, evaluation(ALICE, { depth: 0 })));
    await assertFails(setDoc(ref, evaluation(ALICE, { depth: 100 })));
    await assertFails(setDoc(ref, evaluation(ALICE, { pv: 42 })));
    await assertFails(setDoc(ref, evaluation(ALICE, { uploadedBy: BOB })));
    await assertFails(setDoc(ref, evaluation(ALICE, { uploadedAt: new Date() })));
    await assertSucceeds(
      setDoc(ref, evaluation(ALICE, { cp: null, mate: 3, bestMove: null, pv: '' })),
    );
  });
});
