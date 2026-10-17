import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth/auth.service';
import { UserProfileService } from './core/auth/user-profile.service';
import { BulkEvalService } from './core/data/bulk-eval.service';
import { GamesStoreService } from './core/data/games-store.service';
import { LocalDbService } from './core/data/local-db.service';
import { PositionIndexService } from './core/data/position-index.service';
import { SyncService } from './core/data/sync.service';
import { FirebaseService } from './core/firebase/firebase.service';
import { APP_VERSION } from './version.generated';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatTooltipModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly firebase = inject(FirebaseService);
  protected readonly auth = inject(AuthService);
  protected readonly profiles = inject(UserProfileService);
  protected readonly sync = inject(SyncService);
  protected readonly bulk = inject(BulkEvalService);
  private readonly store = inject(GamesStoreService);
  private readonly db = inject(LocalDbService);
  private readonly index = inject(PositionIndexService);
  private readonly router = inject(Router);

  protected readonly user = this.auth.user;
  protected readonly version = APP_VERSION;
  protected readonly link = computed(() => this.profiles.profile()?.lichess ?? null);
  protected readonly syncLabel = computed(() => {
    switch (this.sync.phase()) {
      case 'pulling':
        return `Syncing… ${this.sync.pulled()} from cloud`;
      case 'downloading':
        return `Downloading from Lichess… ${this.sync.downloaded()}`;
      case 'uploading':
        return `Uploading… ${this.sync.uploaded()} (${this.sync.pending()} left)`;
      case 'error':
        return 'Sync failed';
      case 'done':
        if (this.sync.pending() > 0) return `Synced (${this.sync.pending()} waiting to upload)`;
        return this.sync.warning() ? 'Synced with warnings' : 'Synced';
      default:
        return '';
    }
  });

  private syncedToken: string | null = null;

  constructor() {
    // Start a sync whenever a Lichess link appears or changes (new token).
    effect(() => {
      const link = this.link();
      untracked(() => {
        if (link && link.token !== this.syncedToken) {
          this.syncedToken = link.token;
          void this.sync.sync(link);
        }
        if (!link) this.syncedToken = null;
      });
    });
  }

  protected syncNow(): void {
    const link = this.link();
    if (link) void this.sync.sync(link);
  }

  protected async unlinkLichess(): Promise<void> {
    await this.bulk.stop();
    await this.sync.cancel();
    await this.profiles.unlinkLichess();
    await this.db.clear();
    this.store.reset();
    this.index.reset();
  }

  protected async signOut(): Promise<void> {
    await this.bulk.stop();
    await this.sync.cancel();
    await this.auth.signOut();
    await this.db.clear();
    this.store.reset();
    this.index.reset();
    await this.router.navigateByUrl('/login');
  }
}
