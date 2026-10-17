import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/opening-tree/opening-tree.page').then((m) => m.OpeningTreePage),
  },
  {
    path: 'login',
    loadComponent: () => import('./features/login/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'lichess/callback',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/lichess-callback/lichess-callback.page').then(
        (m) => m.LichessCallbackPage,
      ),
  },
  { path: '**', redirectTo: '' },
];
