import { Injectable, computed, inject, signal } from '@angular/core';
import { SpotifyApi } from './spotify-api';
import { read, write } from './storage';
import type { Card } from './models';

export type PlayerStatus = 'idle' | 'playing' | 'paused' | 'finished';

/**
 * Two ways to play a card:
 *  - `classic`: the song plays from the top until the clip length (or the
 *    listener) stops it.
 *  - `steps`: Songless-style. The song plays 0.1 s from the top and stops. Each
 *    next round replays from the top for longer, up the ladder below, until
 *    someone guesses it or the ladder runs out.
 */
export type GameMode = 'classic' | 'steps';

/** Seconds of the song revealed at each round, always counted from the top. */
export const STEP_LENGTHS = [0.1, 0.5, 1, 2, 4, 8, 16, 30] as const;

@Injectable({ providedIn: 'root' })
export class Player {
  private readonly api = inject(SpotifyApi);

  readonly status = signal<PlayerStatus>('idle');
  readonly card = signal<Card | null>(null);
  readonly seconds = signal(0);
  readonly error = signal('');

  /** Device the music comes out of; empty means "whatever Spotify is using". */
  readonly deviceId = signal<string>(read<string>('device', ''));

  /** Seconds before playback stops on its own; 0 means play until stopped.
      Classic mode only — steps mode has its own ladder. */
  readonly clipLength = signal<number>(read<number>('clip', 0));

  readonly gameMode = signal<GameMode>(read<GameMode>('mode', 'classic'));

  /** Index into STEP_LENGTHS of the round currently on the tape (steps mode). */
  readonly step = signal(0);
  readonly stepLength = computed(() => STEP_LENGTHS[this.step()]);
  readonly lastStep = computed(() => this.step() >= STEP_LENGTHS.length - 1);

  readonly clock = computed(() => {
    const total = this.seconds();
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  });

  private ticker: ReturnType<typeof setInterval> | null = null;
  private clipTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  /** Track length once known, so the clock stops when the song actually ends. */
  private durationMs = 0;
  /** Bumped whenever a new round or card starts or the deck is cleared, so an
      async sequence that belongs to an earlier one can tell it was overtaken. */
  private run = 0;
  /** Estimated one-way delay to the device (steps mode), taken off the stop timer. */
  private latencyMs = 0;

  setDevice(id: string): void {
    this.deviceId.set(id);
    write('device', id);
  }

  setGameMode(mode: GameMode): void {
    if (mode === this.gameMode()) return;
    this.gameMode.set(mode);
    write('mode', mode);
    // The stop rules differ per mode, so a card mid-play under the old rules
    // is dropped rather than left running against a timer it never asked for.
    if (this.status() !== 'idle') void this.clear();
  }

  setClipLength(seconds: number): void {
    this.clipLength.set(seconds);
    write('clip', seconds);
    if (this.gameMode() !== 'classic') return;
    if (this.status() === 'playing') {
      // A clip is running: re-arm the stop timer against the new length so
      // playback honours the change instead of stopping on the old threshold.
      this.armStop(this.seconds());
    } else if (this.status() === 'finished' && this.stopThreshold() > this.seconds()) {
      // Playback already stopped at the old (shorter) threshold, but the new
      // length reaches past where we are — let the player resume up to it.
      this.status.set('paused');
    }
  }

  async start(card: Card): Promise<void> {
    this.error.set('');
    this.card.set(card);
    this.durationMs = 0;
    this.step.set(0);
    if (this.gameMode() === 'steps') return this.startSteps(card);

    if (!(await this.play(card))) return;
    this.status.set('playing');
    this.runClock(0);
  }

  /**
   * Steps mode opens with a 0.1 s round, and a freshly scanned track is the
   * worst case for that: Spotify reports "playing" as soon as the device takes
   * the command, but the device still has to load and buffer the song, so a
   * pause sent 0.1 s later lands before any sound and the round is silent.
   *
   * So the track is cued first: play it with the device muted (where Spotify
   * lets us), wait for the device to actually be playing, pause, rewind and
   * unmute. Round 1 then runs exactly like every later round, from a loaded
   * and paused track, where resume-to-audio is quick and predictable.
   */
  private async startSteps(card: Card): Promise<void> {
    const run = ++this.run;
    const abandoned = () => run !== this.run || this.card() !== card;

    // Mute for the cue, if this device lets an app set its volume. A failure
    // here just means the cue is audible, which is no worse than before.
    const volume = await this.api.volume().catch(() => null);
    const muted =
      volume !== null &&
      (await this.api.setVolume(0).then(
        () => true,
        () => false,
      ));
    if (abandoned()) return this.unmute(muted, volume);

    if (!(await this.play(card))) return this.unmute(muted, volume);

    await this.whenPlaying(run);
    await this.silently(() => this.api.pause());
    await this.silently(() => this.api.seekToStart());
    await this.unmute(muted, volume);
    if (abandoned()) return;

    await this.restart();
  }

  private async unmute(muted: boolean, volume: number | null): Promise<void> {
    if (muted && volume !== null) await this.silently(() => this.api.setVolume(volume));
  }

  /** Sends the play command; on failure clears the card and reports why. */
  private async play(card: Card): Promise<boolean> {
    try {
      await this.api.play(card.uri, this.deviceId() || null);
      return true;
    } catch (error) {
      this.card.set(null);
      this.status.set('idle');
      this.error.set(error instanceof Error ? error.message : 'Playback failed.');
      return false;
    }
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
    // Seek to the top, then make sure playback is actually running: after a clip
    // has finished (or the user paused) Spotify is paused, and seeking alone just
    // moves the playhead — the song would never start again without a resume.
    await this.silently(() => this.api.seekToStart());
    await this.silently(() => this.api.resume());
    this.status.set('playing');
    if (!(await this.settled())) return;
    this.runClock(0);
  }

  /** Steps mode: climb one rung of the ladder and replay from the top. */
  async nextStep(): Promise<void> {
    if (this.lastStep()) return;
    this.stopTimers();
    this.step.update((s) => s + 1);
    await this.restart();
  }

  /**
   * Steps mode: a round is a fraction of a second, so its clock must not start
   * until the device is really playing. Waits for that, then keeps the request
   * latency so the pause can be sent that much early and the fragment ends
   * close to the intended length rather than a round-trip late.
   *
   * Resolves false when the round was abandoned while waiting (next card, next
   * round, mode switch), so the caller must not start a clock for it.
   */
  private async settled(): Promise<boolean> {
    const run = ++this.run;
    this.latencyMs = 0;
    if (this.gameMode() !== 'steps') return true;
    await this.whenPlaying(run);
    return run === this.run && this.status() === 'playing';
  }

  /**
   * Polls Spotify until the device reports it is playing, for at most a couple
   * of seconds — a device that never confirms must not leave the deck stuck.
   * Stops early when `run` has been overtaken.
   */
  private async whenPlaying(run: number): Promise<void> {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && run === this.run) {
      const sent = Date.now();
      let playing = false;
      try {
        playing = await this.api.isPlaying();
      } catch {
        return;
      }
      if (playing) {
        this.latencyMs = Math.round((Date.now() - sent) / 2);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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
    this.run++;
    this.stopTimers();
    this.status.set('idle');
    this.card.set(null);
    this.seconds.set(0);
    this.step.set(0);
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

    const stopAt = this.stopThreshold();
    if (stopAt !== Infinity) {
      const delay = Math.max(0, (stopAt - fromSeconds) * 1000 - this.latencyMs);
      this.clipTimer = setTimeout(() => void this.pause('clip'), delay);
    }
  }

  /** Second at which playback should stop: the clip length (classic) or the
   *  current round length (steps), or the track end, whichever comes first.
   *  Infinity when no bound is known. */
  private stopThreshold(): number {
    const durSec = this.durationMs > 0 ? this.durationMs / 1000 : Infinity;
    if (this.gameMode() === 'steps') return Math.min(this.stepLength(), durSec);
    const clip = this.clipLength();
    const clipSec = clip > 0 ? clip : Infinity;
    return Math.min(clipSec, durSec);
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
