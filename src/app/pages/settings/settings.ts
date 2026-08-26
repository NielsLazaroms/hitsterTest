import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { LucideArrowLeft, LucideShare2 } from '@lucide/angular';
import { DeckService } from '../../core/deck';
import { Player } from '../../core/player';
import { SpotifyApi } from '../../core/spotify-api';
import { SpotifyAuth } from '../../core/spotify-auth';
import { Theme, type ThemePref } from '../../core/theme';
import type { Card, SpotifyDevice } from '../../core/models';

@Component({
  selector: 'app-settings',
  imports: [FormsModule, RouterLink, LucideArrowLeft, LucideShare2],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.html',
  styleUrl: './settings.css',
})
export class Settings {
  private readonly api = inject(SpotifyApi);
  private readonly auth = inject(SpotifyAuth);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly deck = inject(DeckService);
  protected readonly player = inject(Player);
  protected readonly theme = inject(Theme);

  readonly themeOptions: { value: ThemePref; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ];

  readonly devices = signal<SpotifyDevice[]>([]);
  readonly deviceError = signal('');
  readonly loadingDevices = signal(true);
  readonly message = signal('');

  readonly clipOptions = [
    { value: 0, label: 'Play until I stop it' },
    { value: 15, label: 'Stop after 15 seconds' },
    { value: 30, label: 'Stop after 30 seconds' },
    { value: 45, label: 'Stop after 45 seconds' },
  ];

  constructor() {
    void this.loadDevices();

    // Sharing moved to its own page. Older shared QR codes still point at
    // /settings?code=xxxx, so forward those to /share, which now owns the flow.
    const code = this.route.snapshot.queryParamMap.get('code');
    if (code) void this.router.navigate(['/share'], { queryParams: { code } });
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
      if (!Array.isArray(parsed)) {
        this.message.set('That file is not a deck export.');
        return;
      }
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
