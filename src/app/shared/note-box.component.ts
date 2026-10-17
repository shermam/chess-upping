import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
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

  readonly kind = input.required<NoteKind>();
  readonly target = input.required<string>();
  readonly label = input('Notes');

  protected readonly draft = signal('');
  protected readonly status = signal<string | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirtyFor: string | null = null;

  private readonly stored = computed(() => this.notes.get(this.kind(), this.target())?.text ?? '');

  constructor() {
    // When the target changes (or the note arrives from the cloud), show the stored text,
    // unless the user is mid-edit on this very target.
    effect(() => {
      const target = this.target();
      const text = this.stored();
      if (this.dirtyFor !== target) {
        this.draft.set(text);
        this.status.set(null);
      }
    });
    inject(DestroyRef).onDestroy(() => this.flush());
  }

  protected onInput(value: string): void {
    this.draft.set(value);
    this.dirtyFor = this.target();
    this.status.set('Saving…');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  protected flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const target = this.dirtyFor;
    if (target === null) return;
    this.dirtyFor = null;
    void this.notes
      .save(this.kind(), target, this.draft())
      .then(() => this.status.set(this.draft().trim() ? 'Saved' : null))
      .catch((err: unknown) => {
        console.error('note save failed', err);
        this.status.set('Could not save');
      });
  }
}
