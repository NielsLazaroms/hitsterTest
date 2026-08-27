import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { SpotifyAuth } from '../../core/spotify-auth';
import { read, remove } from '../../core/storage';

/**
 * The entry point every route eventually falls back to.
 *
 * It has three jobs: finish the Spotify sign-in when we arrive with ?code=,
 * forward a scanned card id from ?t= into the play screen, and otherwise decide
 * between setup and play.
 */
@Component({
  selector: 'app-launch',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="body center">
        @if (error()) {
          <p class="msg err">{{ error() }}</p>
          <button class="btn" style="max-width: 260px" (click)="toSetup()">Terug naar instellen</button>
        } @else {
          <p class="lede">Verbinden met Spotify…</p>
        }
      </div>
    </div>
  `,
})
export class Launch {
  private readonly auth = inject(SpotifyAuth);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly error = signal('');

  constructor() {
    void this.decide();
  }

  toSetup(): void {
    void this.router.navigate(['/setup']);
  }

  private async decide(): Promise<void> {
    const params = this.route.snapshot.queryParamMap;

    if (params.get('error')) {
      this.error.set(
        `Spotify weigerde de verbinding (${params.get('error')}). ` +
          'Het redirect-adres in het dashboard moet exact overeenkomen.',
      );
      return;
    }

    const code = params.get('code');
    if (code) {
      try {
        await this.auth.exchangeCode(code);

        const next = read<string>('next', '');
        remove('next');
        await this.router.navigateByUrl(next || '/play', { replaceUrl: true });
      } catch (error) {
        this.error.set(error instanceof Error ? error.message : 'Inloggen mislukt.');
      }
      return;
    }

    if (!this.auth.connected()) {
      await this.router.navigate(['/setup'], { replaceUrl: true });
      return;
    }

    const card = params.get('t');
    await this.router.navigate(['/play'], {
      replaceUrl: true,
      queryParams: card ? { t: card } : {},
    });
  }
}
