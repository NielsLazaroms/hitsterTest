import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Icon } from '../../core/icon';
import { Player } from '../../core/player';
import { SpotifyApi } from '../../core/spotify-api';
import { SpotifyAuth } from '../../core/spotify-auth';
import { Theme, type ThemePref } from '../../core/theme';
import type { SpotifyDevice } from '../../core/models';

@Component({
  selector: 'app-settings',
  imports: [FormsModule, RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.html',
  styleUrl: './settings.css',
})
export class Settings {
  private readonly api = inject(SpotifyApi);
  private readonly auth = inject(SpotifyAuth);
  private readonly router = inject(Router);

  protected readonly player = inject(Player);
  protected readonly theme = inject(Theme);

  readonly themeOptions: { value: ThemePref; label: string }[] = [
    { value: 'light', label: 'Licht' },
    { value: 'dark', label: 'Donker' },
    { value: 'system', label: 'Systeem' },
  ];

  readonly devices = signal<SpotifyDevice[]>([]);
  readonly deviceError = signal('');
  readonly loadingDevices = signal(true);

  readonly clipOptions = [
    { value: 0, label: 'Spelen tot ik stop' },
    { value: 15, label: 'Stoppen na 15 seconden' },
    { value: 30, label: 'Stoppen na 30 seconden' },
    { value: 45, label: 'Stoppen na 45 seconden' },
  ];

  constructor() {
    void this.loadDevices();
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
      this.deviceError.set(error instanceof Error ? error.message : 'Kon apparaten niet ophalen.');
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

  signOut(): void {
    this.auth.signOut();
    void this.router.navigate(['/setup']);
  }
}
