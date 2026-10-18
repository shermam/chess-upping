import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { NoteKind, NotesService } from '../core/notes/notes.service';

const SAVE_DELAY_MS = 800;

/** A textarea bound to a private note on a position or game, saved as you type. */
@Component({
  selector: 'app-note-box',
  imports: [MatFormFieldModule, MatInputModule],
  template: `
    <mat-form-field appearance="outline" subscriptSizing="dynamic" class="note">
      <mat-label>{{ label() }}</mat-label>
      <textarea
        #area
        matInput
        rows="2"
        [value]="draft()"
        (input)="onInput($any($event.target).value)"
        (blur)="flush()"
        [attr.aria-label]="label()"
      ></textarea>
      @if (status(); as s) {
        <mat-hint align="end">{{ s }}</mat-hint>
      }
    </mat-form-field>
  `,
  styles: `
    :host {
      display: block;
    }
    .note {
      width: 100%;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NoteBoxComponent {
  private readonly notes = inject(NotesService);
  private readonly area = viewChild<ElementRef<HTMLTextAreaElement>>('area');

  readonly kind = input.required<NoteKind>();
  readonly target = input.required<string>();
  readonly label = input('Notes');

  protected readonly draft = signal('');
  protected readonly status = signal<string | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The target whose draft has unsaved edits, if any. */
  private dirtyFor: string | null = null;
  private shownTarget: string | null = null;

  private readonly stored = computed(() => this.notes.get(this.kind(), this.target())?.text ?? '');

  constructor() {
    effect(() => {
      const target = this.target();
      const text = this.stored();
      untracked(() => {
        if (target !== this.shownTarget) {
          // New position or game: save what was typed for the previous one
          // first (the target can move without a click, e.g. when a drill
          // plays the opponent's reply), then show the new note.
          this.flush();
          this.shownTarget = target;
          this.draft.set(text);
          this.status.set(null);
          return;
        }
        // Same target, stored text changed (our own save echoed back, or
        // another device). Never clobber what the user is typing: the echo of
        // a save differs from the draft only by trimmed whitespace.
        const editing = this.dirtyFor === target || this.isFocused();
        if (!editing && this.draft().trim() !== text) this.draft.set(text);
      });
    });
    inject(DestroyRef).onDestroy(() => this.flush());
  }

  private isFocused(): boolean {
    const el = this.area()?.nativeElement;
    return !!el && typeof document !== 'undefined' && document.activeElement === el;
  }

  protected onInput(value: string): void {
    this.draft.set(value);
    this.dirtyFor = this.target();
    this.status.set('Saving…');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  /** Saves pending edits, if any. Safe to call at any time. */
  protected flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const target = this.dirtyFor;
    if (target === null) return;
    this.dirtyFor = null;
    const text = this.draft();
    void this.notes
      .save(this.kind(), target, text)
      .then((saved) => {
        if (this.dirtyFor !== null || this.target() !== target) return;
        this.status.set(saved ? (text.trim() ? 'Saved' : null) : 'Sign in to save notes');
      })
      .catch((err: unknown) => {
        console.error('note save failed', err);
        if (this.target() === target) this.status.set('Could not save');
      });
  }
}
