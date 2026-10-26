import { Injectable, computed, inject, signal } from '@angular/core';
import { SpotifyApi } from './spotify-api';
import { LOCAL_DEVICE, SpotifySdk } from './spotify-sdk';
import { log } from './debug';
import { read, write } from './storage';
import type { Card } from './models';

/**
 * Moves everyone to the in-app player once.
 *
 * A saved device id survives upgrades, and on a phone that saved id is the
 * phone's own Spotify app — the one configuration that cannot work, since
 * scanning puts it in the background where the OS suspends it. Defaulting
 * only when nothing is stored would leave exactly the players who hit the
 * bug still pointing at it. Anyone who wants a laptop or a speaker picks it
 * again in Settings, and that choice then sticks.
 */
function migratedDevice(): string {
  const saved = read<string>('device', '');
  if (read<number>('deviceSchema', 1) >= 2) return saved;
  write('deviceSchema', 2);
  write('device', LOCAL_DEVICE);
  return LOCAL_DEVICE;
}

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

/**
 * Seconds of the song revealed at each step, always counted from the top.
 *
 * Starts at half a second: a tenth gave almost nothing to go on, and sat below
 * what the transport could reliably deliver anyway. Ends at a full minute, so
 * the last rung is a real chance rather than another near-miss. Eight rungs,
 * which is what the staircase on the Play screen draws.
 */
export const STEP_LENGTHS = [0.5, 1, 2, 4, 8, 16, 30, 60] as const;

/** How long to wait for the in-app player to actually make a sound. Generous
    for a fresh card, whose track still has to be fetched; short for a resume
    or a replay, where it is already loaded. */
const START_CONFIRM_MS = 5000;
const RESUME_CONFIRM_MS = 1500;

/** How long to hold out for our own track before accepting that Spotify
    relinked it to another uri for this market. */
const MISMATCH_GRACE_MS = 1800;

/**
 * Milliseconds to wait before stopping, given where the song was when it was
 * last sampled and how long ago that was.
 *
 * Pulled out of `armStop` because it must be *idempotent*: the stop is armed
 * again when the track length arrives and whenever the clip length changes,
 * and both can happen inside the first second. Counting from a display clock
 * that only advances in whole seconds made a re-arm read the elapsed time as
 * zero and hand the round its full length a second time — on a 0.1 s round,
 * the difference between stopping and playing on.
 *
 * Zero means the moment has already passed, so stop now.
 */
export function stopDelayMs(
  stopAtSeconds: number,
  offsetMs: number,
  sinceSampleMs: number,
  latencyMs: number,
): number {
  return Math.max(0, stopAtSeconds * 1000 - offsetMs - sinceSampleMs - latencyMs);
}

@Injectable({ providedIn: 'root' })
export class Player {
  private readonly api = inject(SpotifyApi);
  private readonly sdk = inject(SpotifySdk);

  readonly status = signal<PlayerStatus>('idle');
  readonly card = signal<Card | null>(null);
  readonly seconds = signal(0);
  readonly error = signal('');

  /** Device the music comes out of: a Spotify device id, the `LOCAL_DEVICE`
      sentinel for the player in this page, or empty for "whatever Spotify is
      using". */
  readonly deviceId = signal<string>(migratedDevice());

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
  /** How far into the song playback was when it was last sampled, so the stop
      timer can count from the top of the song rather than from the command. */
  private offsetMs = 0;
  /** When `offsetMs` was sampled. The stop timer is derived from these two and
      never from the display clock: that one counts whole seconds, so re-arming
      inside the first second (which the track-length lookup does) would read
      the elapsed time as zero and hand the round its full length a second
      time. On a 0.1 s round that is the difference between stopping and
      playing on. */
  private offsetAt = 0;

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
      this.armStop();
    } else if (this.status() === 'finished' && this.stopThreshold() > this.seconds()) {
      // Playback already stopped at the old (shorter) threshold, but the new
      // length reaches past where we are — let the player resume up to it.
      this.status.set('paused');
    }
  }

  /**
   * The device id to aim a play at, resolved afresh every time: the in-app
   * player is handed a new id on every page load, and may be handed another
   * one after going briefly not-ready, so the sentinel is stored instead.
   *
   * Throws rather than falling back to "last active". That fallback is what
   * sends the music back to the suspended phone app, where it is accepted
   * with a 204 and never heard.
   */
  private async target(): Promise<string | null> {
    const saved = this.deviceId();
    if (saved !== LOCAL_DEVICE) return saved || null;

    const id = await this.sdk.waitForDevice();
    if (id) return id;
    throw new Error(
      this.sdk.error() || 'De speler in de app is nog niet klaar. Probeer het zo opnieuw.',
    );
  }

  /**
   * Whether playback runs in this page.
   *
   * Decided by the saved choice alone, never by whether the SDK happens to be
   * ready at this instant: a momentary `not_ready` mid-round would otherwise
   * send a pause to the Connect API, which aims at the last active device —
   * quite possibly the suspended phone app this whole path exists to avoid.
   * The SDK calls do nothing without a player, and a missing state makes
   * confirmation fail with a message, which is the honest outcome.
   */
  private local(): boolean {
    return this.deviceId() === LOCAL_DEVICE;
  }

  private async sendPause(): Promise<void> {
    return this.local() ? this.sdk.pause() : this.api.pause();
  }

  /**
   * The in-app player failed where the Connect path would have re-sent a play
   * to wake a sleeping device. There is no second device here to wake, so the
   * only useful thing is to say so and leave the key to try again.
   */
  private localFault(what: string, error?: unknown): void {
    log('player', 'local-fault', {
      what,
      why: error instanceof Error ? error.message : error === undefined ? '-' : String(error),
    });
    this.error.set('De speler in de app reageert niet. Tik op Opnieuw.');
    this.stopTimers();
    this.status.set('paused');
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
      await this.api.play(card.uri, await this.target());
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
    if (!(await this.settled(0, card.uri, START_CONFIRM_MS))) {
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
    if (this.status() === 'playing') this.armStop();
  }

  async restart(): Promise<void> {
    const card = this.card();
    if (!card) return;
    log('player', 'restart', { card: card.id, step: this.step() });

    // Seek to the top, then make sure playback is actually running: after a clip
    // has finished (or the user paused) Spotify is paused, and seeking alone just
    // moves the playhead — the song would never start again without a resume.
    if (this.local()) {
      // Not swallowed: in the page there is no second device that might have
      // taken the seek instead, so a refusal here is the whole story.
      try {
        await this.sdk.seek(0);
      } catch (error) {
        return this.localFault('seek', error);
      }
    } else {
      await this.silently(() => this.api.seekToStart());
    }

    this.status.set('playing');
    if (!(await this.wake(0))) return;
    if (!(await this.settled(0, card.uri, RESUME_CONFIRM_MS))) return;
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

    // Nothing to wake in the page: the player is right here, and a refusal is
    // a real fault rather than a sleeping device to be prodded with a play.
    if (this.local()) {
      try {
        await this.sdk.resume();
        return true;
      } catch (error) {
        this.localFault('resume', error);
        return false;
      }
    }

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
      on show, when even that is refused. Connect path only — in the page there
      is no sleeping device that a second play would wake. */
  private async recover(positionMs: number): Promise<boolean> {
    const card = this.card();
    if (!card) {
      // Reached when clear() nulled the card while a play was still in flight.
      log('player', 'recover-no-card', { positionMs });
      return false;
    }
    log('player', 'recover', { card: card.id, positionMs });
    try {
      await this.api.play(card.uri, await this.target(), positionMs);
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
  private async settled(positionMs: number, uri: string, timeoutMs: number): Promise<boolean> {
    const run = ++this.run;
    this.latencyMs = 0;
    // Where the song is assumed to be until something confirms otherwise: on a
    // resume that is the position being resumed from, not zero, or the round
    // would be granted its whole length again from that point.
    this.offsetMs = positionMs;
    this.offsetAt = Date.now();
    const abandoned = () => run !== this.run || this.status() !== 'playing';

    // The page's own player reports the truth, locally and at once, so there
    // is nothing to compensate for and no sleeping device to rescue. Confirm
    // it in both modes — it costs tens of milliseconds — so the clock starts
    // when the audio does rather than when the command was acknowledged.
    // Everything below this point is the Connect path.
    if (this.local()) {
      if (await this.confirmLocal(uri, positionMs, run, timeoutMs)) return true;
      if (abandoned()) {
        log('player', 'settled-abandoned', { run, local: true });
        return false;
      }
      this.localFault('confirm');
      return false;
    }

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

  /**
   * Waits until this page's own player is genuinely sounding the track, and
   * records how far into the song that happened.
   *
   * A local reading costs nothing, so this polls every 25 ms and lands within
   * a few tens of milliseconds of the first audio. That is what finally makes
   * a 0.1 s round deliverable: over Connect the confirmation alone took longer
   * than the round, so `armStop` clamped to zero and the first rungs of the
   * ladder were indistinguishable.
   *
   * Three things keep the reading honest:
   *
   *  - It must be our track. Spotify may substitute the recording licensed in
   *    this market, so the uri asked for can arrive as `linked_from` instead;
   *    both are matched. A reading that matches neither but is clearly playing
   *    is accepted anyway and noted, since refusing it would stall the deck
   *    over a detail that did not stop the music.
   *  - It must be near where playback was meant to begin. Right after a seek
   *    the player can still report the previous round's position, and
   *    confirming on that would cut the next round short.
   *  - It must be moving, not merely non-zero.
   */
  private async confirmLocal(
    uri: string,
    fromMs: number,
    run: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const highest = fromMs + 1500;
    let previous = -1;
    let sawStart = false;
    let mismatched = false;
    let polls = 0;
    let loadingPolls = 0;

    while (Date.now() < deadline && run === this.run && this.status() === 'playing') {
      const state = await this.sdk.state();
      polls++;

      // A track Spotify relinked for this market reports a different uri, so a
      // mismatch cannot simply be refused. But accepting one straight away
      // also accepts the *previous* card, which is still loaded and still
      // briefly reported, so insist on our own uri first and take a mismatch
      // only once it is clear no better reading is coming.
      const ours = state?.uris.includes(uri) ?? false;
      const relinkGrace = Date.now() - startedAt >= MISMATCH_GRACE_MS;
      if (state?.loading) loadingPolls++;

      if (
        state === null ||
        !state.playing ||
        // While the track is being fetched the SDK already says it is not
        // paused, and the position is interpolated from a standing event — so
        // it looks like playback that has just begun. Confirming there sets
        // the round going before any sound, and it ends that much short.
        state.loading ||
        !(ours || relinkGrace) ||
        state.progressMs < fromMs ||
        state.progressMs > highest
      ) {
        previous = -1;
      } else {
        if (!ours && !mismatched) {
          mismatched = true;
          log('player', 'uri-mismatch', { want: uri, got: state.uris.join(',') });
        }
        // Having seen the playhead near the start is what proves the seek
        // landed. After a moment, accept movement alone rather than stall.
        if (state.progressMs <= fromMs + 300) sawStart = true;
        const settledEnough = sawStart || Date.now() - startedAt > 600;

        if (previous >= 0 && state.progressMs > previous && settledEnough) {
          this.latencyMs = 0;
          this.offsetMs = state.progressMs;
          this.offsetAt = Date.now();
          log('player', 'confirm-local', {
            run,
            polls,
            // How many polls were spent waiting out the load. On a scan this
            // is the gap that used to be mistaken for playback.
            loadingPolls,
            confirmMs: Date.now() - startedAt,
            offsetMs: this.offsetMs,
            sawStart,
          });
          return true;
        }
        previous = state.progressMs;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    log('player', 'confirm-local-timeout', {
      run,
      polls,
      waitedMs: Date.now() - startedAt,
    });
    return false;
  }

  /** Polls the position for up to three seconds; true once it is moving.
      Connect path only — the in-app player uses `confirmLocal`. */
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
        this.offsetAt = Date.now();
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
    await this.silently(() => this.sendPause());
    if (reason === 'clip' && this.local()) void this.measureClip();
  }

  /**
   * How much of the song was actually audible, measured rather than assumed.
   * Only the in-app player can answer this, and it is the number to hold a
   * round length against when checking whether the ladder really works.
   */
  private async measureClip(): Promise<void> {
    const run = this.run;
    const target = this.stopThreshold();
    const state = await this.sdk.state();
    log('player', 'clip-stopped', {
      targetMs: target === Infinity ? '-' : Math.round(target * 1000),
      reachedMs: state?.progressMs ?? '-',
    });
    await this.confirmPaused(run, 250);
    await this.confirmPaused(run, 1000);
  }

  /**
   * Makes sure the stop actually stopped it.
   *
   * A pause sent while the SDK is still loading a track can be lost: the load
   * finishes, playback begins, and by then the round is over and nothing is
   * armed to end it, so the card plays on to the end of the song. Checking
   * twice and sending it again caps that at a fraction of a second.
   *
   * A `clip-repause` line in the log is the symptom, and the reason to fix the
   * confirmation rather than lean on this.
   */
  private async confirmPaused(run: number, afterMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, afterMs));
    // A new round or card has taken over; its stop is its own business.
    if (run !== this.run) return;

    const state = await this.sdk.state();
    if (!state) return;
    log('player', 'clip-verify', {
      afterMs,
      playing: state.playing,
      progressMs: state.progressMs,
    });
    if (!state.playing) return;

    log('player', 'clip-repause', { afterMs, progressMs: state.progressMs });
    await this.silently(() => this.sdk.pause());
  }

  async resume(): Promise<void> {
    const card = this.card();
    if (!card) return;
    const positionMs = this.seconds() * 1000;
    log('player', 'resume', { positionMs });
    this.status.set('playing');
    if (!(await this.wake(positionMs))) return;
    if (!(await this.settled(positionMs, card.uri, RESUME_CONFIRM_MS))) return;
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
    await this.silently(() => this.sendPause());
  }

  private runClock(fromSeconds: number): void {
    this.stopTimers();
    this.startedAt = Date.now() - fromSeconds * 1000;
    this.seconds.set(fromSeconds);

    this.ticker = setInterval(() => {
      this.seconds.set(Math.floor((Date.now() - this.startedAt) / 1000));
    }, 250);

    this.armStop();
  }

  /**
   * Schedules the single stop timer at the earliest of the clip length and the
   * track's own end.
   *
   * Re-armable, and it has to be idempotent: the track-length lookup arms it a
   * second time a moment after playback starts, and a clip-length change can
   * do so at any point. The deadline is therefore derived from where the song
   * actually was and how long ago that was measured, so arming again lands on
   * the same instant rather than granting a fresh round.
   */
  private armStop(): void {
    if (this.clipTimer) clearTimeout(this.clipTimer);
    this.clipTimer = null;

    const stopAt = this.stopThreshold();
    if (stopAt === Infinity) {
      log('player', 'armStop', { stopAt: 'never' });
      return;
    }

    const sinceSample = this.offsetAt ? Date.now() - this.offsetAt : 0;
    const delay = stopDelayMs(stopAt, this.offsetMs, sinceSample, this.latencyMs);
    log('player', 'armStop', {
      stopAt,
      offsetMs: this.offsetMs,
      sinceSample,
      latencyMs: this.latencyMs,
      delay,
      immediate: delay === 0,
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
