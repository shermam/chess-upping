import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router, RouterLink } from '@angular/router';
import { UserProfileService } from '../../core/auth/user-profile.service';
import { LichessApiService } from '../../core/lichess/lichess-api.service';
import { LichessAuthService } from '../../core/lichess/lichess-auth.service';

/** Landing page for the Lichess OAuth redirect; links the account and returns. */
@Component({
  selector: 'app-lichess-callback-page',
  imports: [MatButtonModule, MatProgressBarModule, RouterLink],
  template: `
    <section class="callback">
      @if (error(); as message) {
        <p class="error">{{ message }}</p>
        <a matButton="filled" routerLink="/">Back to the app</a>
      } @else {
        <p>Linking your Lichess account…</p>
        <mat-progress-bar mode="indeterminate" />
      }
    </section>
  `,
  styles: `
    .callback {
      max-width: 480px;
      margin: 64px auto;
      padding: 0 16px;
    }
    .error {
      color: var(--mat-sys-error);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LichessCallbackPage {
  private readonly lichessAuth = inject(LichessAuthService);
  private readonly lichessApi = inject(LichessApiService);
  private readonly profiles = inject(UserProfileService);
  private readonly router = inject(Router);

  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.complete();
  }

  private async complete(): Promise<void> {
    try {
      const { token, next } = await this.lichessAuth.completeLogin(
        new URLSearchParams(location.search),
      );
      const account = await this.lichessApi.account(token);
      await this.profiles.linkLichess({
        id: account.id,
        username: account.username,
        token,
        linkedAt: Date.now(),
      });
      await this.router.navigateByUrl(next);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }
}
