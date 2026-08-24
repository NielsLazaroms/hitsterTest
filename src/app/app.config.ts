import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { DeckService } from './core/deck';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    // A scanned card resolves against the deck synchronously, so any deck
    // shipped with the app has to be in place before the first screen renders.
    provideAppInitializer(() => inject(DeckService).loadBundled()),
  ],
};
