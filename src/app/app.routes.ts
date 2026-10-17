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
    path: 'games/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./features/game/game.page').then((m) => m.GamePage),
  },
  {
    path: 'mistakes',
    canActivate: [authGuard],
    loadComponent: () => import('./features/mistakes/mistakes.page').then((m) => m.MistakesPage),
  },
  {
    path: 'drills',
    canActivate: [authGuard],
    loadComponent: () => import('./features/drills/drills.page').then((m) => m.DrillsPage),
  },
  {
    path: 'engine',
    canActivate: [authGuard],
    loadComponent: () => import('./features/engine/engine.page').then((m) => m.EnginePage),
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
