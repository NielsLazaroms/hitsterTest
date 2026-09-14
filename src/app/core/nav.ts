import { Location } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

/**
 * The back arrow means "the screen I came from", not a fixed address.
 *
 * Browser history cannot be read, only stepped through, so this mirrors the
 * app's own navigation into a trail. A back arrow then steps back when there
 * is somewhere to step back to, and only falls back to the screen's natural
 * parent when there is not: a deep link, a reload, a card link opened fresh.
 */
@Injectable({ providedIn: 'root' })
export class Nav {
  private readonly router = inject(Router);
  private readonly location = inject(Location);

  /** In-app screens visited, oldest first; the last entry is the current one. */
  private readonly trail: string[] = [];

  constructor() {
    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => this.record(event.urlAfterRedirects));
  }

  /** Go to the previous screen, or to `fallback` when there is none. */
  back(fallback: string): void {
    if (this.trail.length > 1) this.location.back();
    else void this.router.navigateByUrl(fallback, { replaceUrl: true });
  }

  private record(url: string): void {
    const navigation = this.router.lastSuccessfulNavigation();
    if (navigation?.trigger === 'popstate') {
      // The browser went back (or forward): drop the screen we left. Forward is
      // rare enough here that treating it as a step back is the safe reading.
      this.trail.pop();
      if (this.trail[this.trail.length - 1] !== url) this.trail.push(url);
    } else if (navigation?.extras.replaceUrl && this.trail.length > 0) {
      // A redirect stands in for the screen it replaced, as in the browser.
      this.trail[this.trail.length - 1] = url;
    } else {
      this.trail.push(url);
    }
  }
}
