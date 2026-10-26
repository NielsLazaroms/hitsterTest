import { Injectable, computed, inject, signal } from '@angular/core';
import { SpotifyApi } from './spotify-api';
import { log } from './debug';
import { read, write } from './storage';
import type { Card } from './models';

export type PlayerStatus = 'idle' | 'playing' | 'paused' | 'finished';

/**
 * Two ways to play a card:
 *  - `classic`: the song plays from the top until the clip length (or the
 *    listener) stops it.
 *  - `steps`: Songless-style. The song plays 0.1 s from the top and stops. Each
 *    "next step" replays from the top for longer, up the ladder below, until
 *    someone guesses it or the ladder runs out.
 */
export type GameMode = 'classic' | 'steps';

/** Seconds of the song revealed at each step, always counted from the top. */
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

  /** Index into STEP_LENGTHS of the step currently on the tape (steps mode). */
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
  /** Bumped whenever a new round or card starts, so a wait that belongs to an
      earlier one can tell it has been overtaken. */
  private run = 0;
  /** Estimated one-way delay to the device (steps mode), taken off the stop timer. */
  private latencyMs = 0;
  /** How far into the song the device already was when the clock started
      (steps mode), so the stop timer counts from the top of the song. */
  private offsetMs = 0;

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
    log('player', 'start', {
      card: card.id,
      mode: this.gameMode(),
      device: this.deviceId() || 'last-active',
      clip: this.clipLength(),
    });
    this.error.set('');
    this.card.set(card);
    this.durationMs = 0;
    this.step.set(0);
    try {
      await this.api.play(card.uri, this.deviceId() || null);
    } catch (error) {
      log('player', 'start-failed', {
        why: error instanceof Error ? error.message : String(error),
      });
      this.card.set(null);
      this.status.set('idle');
      this.error.set(error instanceof Error ? error.message : 'Playback failed.');
      return;
    }
    this.status.set('playing');
    if (!(await this.settled(0))) {
      log('player', 'start-abandoned', { card: card.id });
      return;
    }
    this.runClock(0);
  }

  /**
   * Once the track length is known, arm the clock to stop when the song ends
   * (or at the clip length, whichever comes first) — otherwise "play until I
   * stop it" leaves the tape counter running after the audio has finished.
   */
  setDuration(id: string, durationMs: number): void {
    if (this.card()?.id !== id) {
      log('player', 'duration-stale', { id, current: this.card()?.id ?? '-' });
      return;
    }
    log('player', 'duration', { id, durationMs });
    this.durationMs = durationMs;
    if (this.status() === 'playing') this.armStop(this.seconds());
  }

  async restart(): Promise<void> {
    log('player', 'restart', { card: this.card()?.id ?? '-', step: this.step() });
    // Seek to the top, then make sure playback is actually running: after a clip
    // has finished (or the user paused) Spotify is paused, and seeking alone just
    // moves the playhead — the song would never start again without a resume.
    await this.silently(() => this.api.seekToStart());
    this.status.set('playing');
    if (!(await this.wake(0))) return;
    if (!(await this.settled(0))) return;
    this.runClock(0);
  }

  /**
   * Resume playback, and if the device has gone quiet, start the track there
   * again from the given position. On iOS in particular, Spotify is suspended
   * within a short while of being paused in the background, and from then on a
   * bare resume is refused or silently ignored, while a play aimed at the
   * device's id still reaches it as long as it is listed. Errors are shown, not
   * swallowed: a dead key with no explanation is the one thing to avoid.
   */
  private async wake(positionMs: number): Promise<boolean> {
    this.error.set('');
    try {
      await this.api.resume();
      return true;
    } catch (error) {
      log('player', 'wake-refused', {
        why: error instanceof Error ? error.message : String(error),
      });
      return this.recover(positionMs);
    }
  }

  /** The last resort: a full play on the saved device. False, with the reason
      on show, when even that is refused. */
  private async recover(positionMs: number): Promise<boolean> {
    const card = this.card();
    if (!card) {
      // Reached when clear() nulled the card while a play was still in flight.
      log('player', 'recover-no-card', { positionMs });
      return false;
    }
    log('player', 'recover', { card: card.id, positionMs });
    try {
      await this.api.play(card.uri, this.deviceId() || null, positionMs);
      return true;
    } catch (error) {
      log('player', 'recover-failed', {
        why: error instanceof Error ? error.message : String(error),
      });
      this.error.set(error instanceof Error ? error.message : 'Afspelen mislukt.');
      this.stopTimers();
      this.status.set('paused');
      return false;
    }
  }

  /** Steps mode: climb one rung of the ladder and replay from the top. */
  async nextStep(): Promise<void> {
    if (this.lastStep()) return;
    log('player', 'nextStep', { from: this.step(), to: this.step() + 1 });
    this.stopTimers();
    this.step.update((s) => s + 1);
    await this.restart();
  }

  /**
   * Steps mode: a round is a fraction of a second, but Spotify acknowledges a
   * play command long before the device has loaded the track and made a sound,
   * and its "is playing" flag flips just as early. Timed from either, the pause
   * for a 0.1 s round lands before any audio, and a freshly scanned card plays
   * nothing. The one signal that means sound is actually coming out is the
   * track position moving, so this polls the position and only starts the
   * round once two readings show it advancing. (Two, because right after a
   * rewind the device may still report where the previous round stopped.)
   *
   * It also keeps what it learned: how far in the song already was when the
   * clock started, and the request latency, so the stop timer can be set for
   * the intended length from the top of the song and the pause sent one leg
   * early. A short round therefore ends as soon as it is confirmed audible.
   *
   * A device that accepted the command but never starts (a suspended Spotify
   * app answers commands it does not act on) gets one full play aimed at it
   * before the round is run regardless.
   *
   * Classic mode does not need the precision, but it needs the same rescue: it
   * checks once, a moment after resuming, that the device really plays.
   *
   * Resolves false when the round was abandoned while waiting (next card, next
   * round, mode switch), so the caller must not start a clock for it.
   */
  private async settled(positionMs: number): Promise<boolean> {
    const run = ++this.run;
    this.latencyMs = 0;
    this.offsetMs = 0;
    const abandoned = () => run !== this.run || this.status() !== 'playing';

    if (this.gameMode() !== 'steps') {
      void this.verify(run, positionMs);
      return true;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      if (await this.advancing(run)) return true;
      if (abandoned()) {
        log('player', 'settled-abandoned', { run, attempt });
        return false;
      }
      if (attempt === 0 && !(await this.recover(positionMs))) return false;
    }
    // Never confirmed: run the round anyway rather than leave the deck stuck.
    // Nothing is shown to the player here, so a device that accepts commands
    // and stays silent reaches the round with no message at all.
    log('player', 'settled-unconfirmed', { run, silent: true });
    return !abandoned();
  }

  /** Polls the position for up to three seconds; true once it is moving. */
  private async advancing(run: number): Promise<boolean> {
    const deadline = Date.now() + 3000;
    const startedAt = Date.now();
    let previous = -1;
    let polls = 0;
    while (Date.now() < deadline && run === this.run && this.status() === 'playing') {
      const sent = Date.now();
      let state: { playing: boolean; progressMs: number } | null;
      try {
        state = await this.api.playbackState();
      } catch {
        log('player', 'advancing-error', { run, polls });
        return false;
      }
      polls++;
      const progress = state?.playing ? state.progressMs : 0;
      if (progress > 0 && previous >= 0 && progress > previous) {
        this.latencyMs = Math.round((Date.now() - sent) / 2);
        // The reading is one leg old by the time it arrives.
        this.offsetMs = progress + this.latencyMs;
        // offsetMs is how deep into the song confirmation landed. A round
        // shorter than this cannot be delivered: armStop will clamp to 0.
        log('player', 'advancing-ok', {
          run,
          polls,
          confirmMs: Date.now() - startedAt,
          offsetMs: this.offsetMs,
          latencyMs: this.latencyMs,
        });
        return true;
      }
      previous = progress;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    log('player', 'advancing-timeout', { run, polls, waitedMs: Date.now() - startedAt });
    return false;
  }

  /** Classic mode: a moment after resuming, make sure the device is really
      playing, and wake it with a full play if it is not. */
  private async verify(run: number, positionMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (run !== this.run || this.status() !== 'playing') return;
    let state: { playing: boolean; progressMs: number } | null = null;
    try {
      state = await this.api.playbackState();
    } catch {
      return;
    }
    if (run !== this.run || this.status() !== 'playing') return;
    // Only `is_playing` is checked here, never the position, so a device that
    // reports itself as playing but makes no sound passes this test.
    log('player', 'verify', { run, playing: state?.playing ?? false, progressMs: state?.progressMs });
    if (!state?.playing) await this.recover(positionMs + 1500);
  }

  async pause(reason: 'user' | 'clip' = 'user'): Promise<void> {
    log('player', 'pause', { reason, atSeconds: this.seconds() });
    this.stopTimers();
    this.status.set(reason === 'clip' ? 'finished' : 'paused');
    await this.silently(() => this.api.pause());
  }

  async resume(): Promise<void> {
    const positionMs = this.seconds() * 1000;
    log('player', 'resume', { positionMs });
    this.status.set('playing');
    if (!(await this.wake(positionMs))) return;
    if (!(await this.settled(positionMs))) return;
    this.runClock(this.seconds());
  }

  /** Stops playback and clears the current card, back to the scan screen. */
  async clear(): Promise<void> {
    // Sends a pause. If a scan has already started the next card, this pause
    // can overtake that play and silence the song that just began.
    log('player', 'clear', { card: this.card()?.id ?? '-', status: this.status() });
    this.run++;
    this.error.set('');
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
    if (stopAt === Infinity) {
      log('player', 'armStop', { stopAt: 'never' });
      return;
    }

    const raw = (stopAt - fromSeconds) * 1000 - this.offsetMs - this.latencyMs;
    const delay = Math.max(0, raw);
    // `raw` below zero means the round is shorter than the time confirmation
    // took, so the pause is sent the instant the clock starts: audible as the
    // song stopping with nothing played.
    log('player', 'armStop', {
      stopAt,
      fromSeconds,
      offsetMs: this.offsetMs,
      latencyMs: this.latencyMs,
      raw,
      delay,
      immediate: raw <= 0,
    });
    this.clipTimer = setTimeout(() => void this.pause('clip'), delay);
  }

  /** Second at which playback should stop: the clip length (classic) or the
   *  current step length (steps), or the track end, whichever comes first.
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
    } catch (error) {
      // Swallowed on purpose, but a pause or seek that never landed explains
      // a lot of odd playback, so the log still gets it.
      log('player', 'swallowed', {
        why: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
