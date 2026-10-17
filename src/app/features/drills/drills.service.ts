import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Unsubscribe, collection, doc, onSnapshot, setDoc } from 'firebase/firestore';
import { AuthService } from '../../core/auth/auth.service';
import { FirebaseService } from '../../core/firebase/firebase.service';
import { DrillCard } from './cards';
import { DrillState, Grade, review } from './scheduler';

/**
 * Keeps the spaced-repetition state of drill cards under `users/{uid}/drills`
 * (document id = position key) and decides what to practise next: due cards
 * first, then new ones in the order the card builder proposes.
 */
@Injectable({ providedIn: 'root' })
export class DrillsService {
  private readonly firebase = inject(FirebaseService);
  private readonly auth = inject(AuthService);
  private unsubscribe: Unsubscribe | null = null;

  readonly states = signal<ReadonlyMap<string, DrillState>>(new Map());
  readonly loaded = signal(false);
  /** Keys answered in this session, so a card is not shown twice in a row. */
  readonly seenThisSession = signal<ReadonlySet<string>>(new Set());
  readonly reviewedToday = computed(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    let n = 0;
    for (const s of this.states().values()) if (s.lastReviewed >= start.getTime()) n++;
    return n;
  });

  constructor() {
    effect(() => {
      const uid = this.auth.user()?.uid ?? null;
      untracked(() => this.watch(uid));
    });
  }

  private watch(uid: string | null): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.states.set(new Map());
    this.loaded.set(false);
    if (!uid) return;
    this.unsubscribe = onSnapshot(
      collection(this.firebase.firestore, 'users', uid, 'drills'),
      (snapshot) => {
        const map = new Map<string, DrillState>();
        for (const d of snapshot.docs) {
          const s = d.data() as Partial<DrillState>;
          if (typeof s.due !== 'number' || typeof s.ease !== 'number') continue;
          map.set(d.id, {
            key: d.id,
            ease: s.ease,
            intervalDays: s.intervalDays ?? 0,
            due: s.due,
            reps: s.reps ?? 0,
            lapses: s.lapses ?? 0,
            lastReviewed: s.lastReviewed ?? 0,
          });
        }
        this.states.set(map);
        this.loaded.set(true);
      },
      (err) => console.error('drills snapshot failed', err),
    );
  }

  /** Splits cards into due, new and scheduled for later. */
  queue(
    cards: readonly DrillCard[],
    now = Date.now(),
  ): { due: DrillCard[]; fresh: DrillCard[]; later: number } {
    const states = this.states();
    const seen = this.seenThisSession();
    const due: DrillCard[] = [];
    const fresh: DrillCard[] = [];
    let later = 0;
    for (const card of cards) {
      const s = states.get(card.key);
      if (!s) {
        if (!seen.has(card.key)) fresh.push(card);
      } else if (s.due <= now) {
        if (!seen.has(card.key)) due.push(card);
      } else later++;
    }
    due.sort((a, b) => (states.get(a.key)?.due ?? 0) - (states.get(b.key)?.due ?? 0));
    return { due, fresh, later };
  }

  async record(card: DrillCard, grade: Grade): Promise<void> {
    const uid = this.auth.user()?.uid;
    const now = Date.now();
    const next = review(this.states().get(card.key) ?? null, card.key, grade, now);
    // Optimistic local update so the queue moves on immediately.
    this.states.update((m) => new Map(m).set(card.key, next));
    this.seenThisSession.update((s) => new Set(s).add(card.key));
    if (!uid) return;
    try {
      await setDoc(doc(this.firebase.firestore, 'users', uid, 'drills', card.key), next);
    } catch (err) {
      console.error('drill state save failed', err);
    }
  }
}
