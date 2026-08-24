import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { SpotifyAuth } from './spotify-auth';

/**
 * Sends anyone without a Spotify login back to the setup screen.
 *
 * Without this, a screen reached before connecting still renders and only
 * fails once it calls the API, leaving "Not connected to Spotify." on the
 * page with nothing to press. Any query string is carried across so a card
 * scanned before signing in still opens its track afterwards.
 */
export const connectedGuard: CanActivateFn = (_route, state) => {
  const auth = inject(SpotifyAuth);
  const router = inject(Router);

  if (auth.connected()) return true;

  return router.createUrlTree(['/setup'], {
    queryParams: { next: state.url },
  });
};
