import { Routes } from '@angular/router';

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
    loadComponent: () => import('./pages/play/play').then((m) => m.Play),
  },
  {
    path: 'settings',
    loadComponent: () => import('./pages/settings/settings').then((m) => m.Settings),
  },
  {
    path: 'deck',
    loadComponent: () => import('./pages/deck-builder/deck-builder').then((m) => m.DeckBuilder),
  },
  {
    path: 'print',
    loadComponent: () => import('./pages/print/print').then((m) => m.PrintSheet),
  },
  { path: '**', redirectTo: '' },
];
