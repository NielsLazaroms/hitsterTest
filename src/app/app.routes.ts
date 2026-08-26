import { Routes } from '@angular/router';
import { connectedGuard } from './core/connected-guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/launch/launch').then((m) => m.Launch),
  },
  {
    path: 'setup',
    loadComponent: () => import('./pages/setup/setup').then((m) => m.Setup),
  },
  {
    path: 'play',
    canActivate: [connectedGuard],
    loadComponent: () => import('./pages/play/play').then((m) => m.Play),
  },
  {
    path: 'settings',
    canActivate: [connectedGuard],
    loadComponent: () => import('./pages/settings/settings').then((m) => m.Settings),
  },
  {
    path: 'deck',
    canActivate: [connectedGuard],
    loadComponent: () => import('./pages/deck-builder/deck-builder').then((m) => m.DeckBuilder),
  },
  {
    path: 'print',
    loadComponent: () => import('./pages/print/print').then((m) => m.PrintSheet),
  },
  { path: '**', redirectTo: '' },
];
