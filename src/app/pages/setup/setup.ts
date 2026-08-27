import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { isInAppBrowser } from '../../core/environment';
import { SpotifyAuth } from '../../core/spotify-auth';
import { remove, write } from '../../core/storage';

@Component({
  selector: 'app-setup',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './setup.html',
  styleUrl: './setup.css',
})
export class Setup {
  private readonly auth = inject(SpotifyAuth);
  private readonly route = inject(ActivatedRoute);

  readonly redirectUri = this.auth.redirectUri;
  /** With an id compiled in there is nothing for the player to fill in. */
  readonly builtIn = this.auth.hasBuiltInClientId();
  /** Chat apps open links in a WebView that breaks sign-in and the camera. */
  readonly inApp = isInAppBrowser();
  readonly clientId = signal(this.auth.clientId());
  readonly error = signal('');
  readonly copyLabel = signal('Kopiëren');

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.redirectUri);
      this.copyLabel.set('Gekopieerd');
    } catch {
      this.copyLabel.set('Selecteer het met de hand');
    }
    setTimeout(() => this.copyLabel.set('Kopiëren'), 1600);
  }

  async connect(): Promise<void> {
    const id = (this.builtIn ? this.auth.clientId() : this.clientId()).trim();
    if (!/^[a-f0-9]{20,}$/i.test(id)) {
      this.error.set(
        'Dit lijkt niet op een Client ID. Dat is een lange reeks letters en cijfers.',
      );
      return;
    }
    this.error.set('');

    // Survives the round trip to Spotify, which replaces the whole page.
    const next = this.route.snapshot.queryParamMap.get('next');
    if (next) write('next', next);
    else remove('next');

    await this.auth.begin(id);
  }
}
