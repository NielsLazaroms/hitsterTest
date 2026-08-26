import { Injectable, computed, inject, signal } from '@angular/core';
import { SpotifyApi } from './spotify-api';
import { read, write } from './storage';
import type { Card } from './models';

export type PlayerStatus = 'idle' | 'playing' | 'paused' | 'finished';

@Injectable({ providedIn: 'root' })
export class Player {
  private readonly api = inject(SpotifyApi);

  readonly status = signal<PlayerStatus>('idle');
  readonly card = signal<Card | null>(null);
  readonly seconds = signal(0);
  readonly error = signal('');

  /** Device the music comes out of; empty means "whatever Spotify is using". */
  readonly deviceId = signal<string>(read<string>('device', ''));

  /** Seconds before playback stops on its own; 0 means play until stopped. */
  readonly clipLength = signal<number>(read<number>('clip', 0));

  readonly clock = computed(() => {
    const total = this.seconds();
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  });

  private ticker: ReturnType<typeof setInterval> | null = null;
  private clipTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  /** Track length once known, so the clock stops when the song actually ends. */
  private durationMs = 0;

  setDevice(id: string): void {
    this.deviceId.set(id);
    write('device', id);
  }

  setClipLength(seconds: number): void {
    this.clipLength.set(seconds);
    write('clip', seconds);
  }

  async start(card: Card): Promise<void> {
    this.error.set('');
    this.card.set(card);
    this.durationMs = 0;
    try {
      await this.api.play(card.uri, this.deviceId() || null);
    } catch (error) {
      this.card.set(null);
      this.status.set('idle');
      this.error.set(error instanceof Error ? error.message : 'Playback failed.');
      return;
    }
    this.status.set('playing');
    this.runClock(0);
  }

  /**
   * Fills in the answer for the reveal once it has been looked up, without
   * touching playback. Guarded by id so a slow lookup for a card the player has
   * already moved past cannot overwrite the current one.
   */
  reveal(id: string, card: Card): void {
    if (this.card()?.id === id) this.card.set(card);
  }

  /**
   * Once the track length is known, arm the clock to stop when the song ends
   * (or at the clip length, whichever comes first) — otherwise "play until I
   * stop it" leaves the tape counter running after the audio has finished.
   */
  setDuration(id: string, durationMs: number): void {
    if (this.card()?.id !== id) return;
    this.durationMs = durationMs;
    if (this.status() === 'playing') this.armStop(this.seconds());
  }

  async restart(): Promise<void> {
    await this.silently(() => this.api.seekToStart());
    this.status.set('playing');
    this.runClock(0);
  }

  async pause(reason: 'user' | 'clip' = 'user'): Promise<void> {
    this.stopTimers();
    this.status.set(reason === 'clip' ? 'finished' : 'paused');
    await this.silently(() => this.api.pause());
  }

  async resume(): Promise<void> {
    this.status.set('playing');
    await this.silently(() => this.api.resume());
    this.runClock(this.seconds());
  }

  /** Stops playback and clears the current card, back to the scan screen. */
  async clear(): Promise<void> {
    this.stopTimers();
    this.status.set('idle');
    this.card.set(null);
    this.seconds.set(0);
    await this.silently(() => this.api.pause());
  }

  private runClock(fromSeconds: number): void {
    this.stopTimers();
    this.startedAt = Date.now() - fromSeconds * 1000;
    this.seconds.set(fromSeconds);

    this.ticker = setInterval(() => {
      this.seconds.set(Math.floor((Date.now() - this.startedAt) / 1000));
    }, 250);

    this.armStop(fromSeconds);
  }

  /**
   * Schedules the single stop timer at the earliest of the clip length and the
   * track's own end. Re-armable, so it updates when the duration arrives after
   * playback has already started.
   */
  private armStop(fromSeconds: number): void {
    if (this.clipTimer) clearTimeout(this.clipTimer);
    this.clipTimer = null;

    const clip = this.clipLength();
    const clipSec = clip > 0 ? clip : Infinity;
    const durSec = this.durationMs > 0 ? this.durationMs / 1000 : Infinity;
    const stopAt = Math.min(clipSec, durSec);

    if (stopAt !== Infinity) {
      const delay = Math.max(0, stopAt - fromSeconds) * 1000;
      this.clipTimer = setTimeout(() => void this.pause('clip'), delay);
    }
  }

  private stopTimers(): void {
    if (this.ticker) clearInterval(this.ticker);
    if (this.clipTimer) clearTimeout(this.clipTimer);
    this.ticker = null;
    this.clipTimer = null;
  }

  /** Transport hiccups must never break the game flow mid-round. */
  private async silently(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch {
      /* ignore */
    }
  }
}
