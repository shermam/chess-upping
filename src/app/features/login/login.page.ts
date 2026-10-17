import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  selector: 'app-login-page',
  imports: [MatButtonModule, MatCardModule, MatIconModule],
  template: `
    <section class="login">
      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-card-title>Chess Upping</mat-card-title>
          <mat-card-subtitle>Explore your own games like an opening book</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <p>Sign in to link your Lichess account and download your games.</p>
          @if (error(); as message) {
            <p class="error">{{ message }}</p>
          }
        </mat-card-content>
        <mat-card-actions>
          <button matButton="filled" (click)="signIn()" [disabled]="busy()">
            <mat-icon>login</mat-icon>
            Sign in with Google
          </button>
        </mat-card-actions>
      </mat-card>
    </section>
  `,
  styles: `
    .login {
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
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async signIn(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.signInWithGoogle();
      const next = this.route.snapshot.queryParamMap.get('next') || '/';
      await this.router.navigateByUrl(next);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
