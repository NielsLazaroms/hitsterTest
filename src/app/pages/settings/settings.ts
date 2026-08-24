import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { DeckService } from '../../core/deck';
import { Player } from '../../core/player';
import { qrSvg } from '../../core/qr';
import { SpotifyApi } from '../../core/spotify-api';
import { SpotifyAuth } from '../../core/spotify-auth';
import type { Card, SpotifyDevice } from '../../core/models';

@Component({
  selector: 'app-settings',
  imports: [FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.html',
  styleUrl: './settings.css',
})
export class Settings {
  private readonly api = inject(SpotifyApi);
  private readonly auth = inject(SpotifyAuth);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly deck = inject(DeckService);
  protected readonly player = inject(Player);

  readonly devices = signal<SpotifyDevice[]>([]);
  readonly deviceError = signal('');
  readonly loadingDevices = signal(true);
  readonly message = signal('');

  /** The code returned after sharing, and a QR that deep-links to it. */
  readonly shareCode = signal('');
  readonly shareQr = signal<SafeHtml | null>(null);
  readonly sharing = signal(false);

  /** The code someone types in to pull a deck from another device. */
  readonly codeInput = signal('');
  readonly loadingCode = signal(false);

  readonly clipOptions = [
    { value: 0, label: 'Play until I stop it' },
    { value: 15, label: 'Stop after 15 seconds' },
    { value: 30, label: 'Stop after 30 seconds' },
    { value: 45, label: 'Stop after 45 seconds' },
  ];

  constructor() {
    void this.loadDevices();

    const params = this.route.snapshot.queryParamMap;

    // A QR scanned from another device lands here as /settings?code=xxxx —
    // pull that deck straight away so scanning is all it takes.
    const code = params.get('code');
    if (code) {
      this.codeInput.set(code);
      void this.loadCode();
      return;
    }

    // The deck builder sends /settings?share=1 after saving, so a freshly built
    // deck shows its share code without a second button press.
    if (params.get('share') && this.deck.count()) {
      void this.shareDeck();
    }
  }

  async shareDeck(): Promise<void> {
    this.sharing.set(true);
    this.message.set('');
    this.shareCode.set('');
    this.shareQr.set(null);
    try {
      const code = await this.deck.share();
      this.shareCode.set(code);
      const link = `${location.origin}/settings?code=${code}`;
      this.shareQr.set(this.sanitizer.bypassSecurityTrustHtml(qrSvg(link)));
      this.message.set('Deck shared. Enter the code on the other device, or scan the QR.');
    } catch (error) {
      this.message.set(error instanceof Error ? error.message : 'Could not share the deck.');
    } finally {
      this.sharing.set(false);
    }
  }

  async loadCode(): Promise<void> {
    const code = this.codeInput().trim();
    if (!code) return;
    this.loadingCode.set(true);
    this.message.set('');
    try {
      const count = await this.deck.loadShared(code);
      this.message.set(`Loaded ${count} cards from ${code.toLowerCase()}.`);
      this.codeInput.set('');
    } catch (error) {
      this.message.set(error instanceof Error ? error.message : 'Could not load that code.');
    } finally {
      this.loadingCode.set(false);
    }
  }

  async loadDevices(): Promise<void> {
    this.loadingDevices.set(true);
    this.deviceError.set('');
    try {
      const found = await this.api.devices();
      this.devices.set(found);
      if (!this.player.deviceId()) {
        const active = found.find((d) => d.is_active) ?? found[0];
        if (active) this.player.setDevice(active.id);
      }
    } catch (error) {
      this.deviceError.set(error instanceof Error ? error.message : 'Could not list devices.');
    } finally {
      this.loadingDevices.set(false);
    }
  }

  onDeviceChange(id: string): void {
    this.player.setDevice(id);
  }

  onClipChange(value: string): void {
    this.player.setClipLength(Number(value));
  }

  exportDeck(): void {
    const blob = new Blob([JSON.stringify(this.deck.cards(), null, 2)], {
      type: 'application/json',
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'deck.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  }

  async importDeck(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) throw new Error('not a deck');
      this.deck.save(parsed as Card[]);
      this.message.set(`Imported ${parsed.length} cards.`);
    } catch {
      this.message.set('That file is not a deck export.');
    } finally {
      input.value = '';
    }
  }

  signOut(): void {
    this.auth.signOut();
    void this.router.navigate(['/setup']);
  }
}
