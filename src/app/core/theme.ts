import { Injectable, effect, signal } from '@angular/core';
import { read, write } from './storage';

export type ThemePref = 'system' | 'light' | 'dark';

/**
 * The light/dark preference, persisted and applied to <html data-theme>.
 *
 * 'system' removes the attribute so the CSS `prefers-color-scheme` media query
 * governs; 'light'/'dark' pin it and win over the OS in both directions. An
 * inline script in index.html applies the stored value before first paint, so
 * this service only needs to keep it in sync as the choice changes.
 */
@Injectable({ providedIn: 'root' })
export class Theme {
  readonly pref = signal<ThemePref>(read<ThemePref>('theme', 'light'));

  constructor() {
    effect(() => {
      const pref = this.pref();
      write('theme', pref);
      const root = document.documentElement;
      if (pref === 'system') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', pref);
    });
  }

  set(pref: ThemePref): void {
    this.pref.set(pref);
  }
}
