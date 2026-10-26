import { Injectable, computed, inject, signal } from '@angular/core';
import { SpotifyAuth } from './spotify-auth';
import { log } from './debug';

/**
 * Playback inside the page, through Spotify's Web Playback SDK.
 *
 * The Connect API cannot play anything by itself: it commands another device,
 * and on a phone that device is the Spotify app — which is necessarily in the
 * background while the camera is scanning, and which the OS then suspends.
 * Spotify's servers keep answering 204 for a device that will never make a
 * sound. This registers the page itself as the device instead, so there is no
 * background app left to suspend, and no "open Spotify first".
 *
 * Loaded from the Play screen rather than at boot: it pulls a script off
 * Spotify's CDN, which a player who never reaches Play should not pay for, and
 * which the jsdom tests must not reach at all.
 */

const SCRIPT = 'https://sdk.scdn.co/spotify-player.js';

/** Shown in everyone's Spotify device list, so it says what it is. */
const PLAYER_NAME = 'Mixtape (in de app)';

/**
 * Stored in place of a device id to mean "the player in this page".
 *
 * The SDK is handed a fresh device id on every page load, so persisting the
 * real one would point at a player that no longer exists by the next session.
 */
export const LOCAL_DEVICE = 'local';

interface SdkTrack {
  uri: string;
  /** Set when Spotify swapped the track for the one licensed in this market;
      the uri we asked for is then here rather than in `uri`. */
  linked_from?: { uri?: string | null } | null;
}

interface SdkState {
  paused: boolean;
  position: number;
  /**
   * True while the track is still being fetched. Crucial, because the SDK
   * reports `paused: false` at a standing position throughout that window,
   * and `getCurrentState()` interpolates the position from the last event —
   * so a poll during a load sees a position that appears to be moving when
   * nothing is audible yet.
   */
  loading?: boolean;
  track_window?: { current_track?: SdkTrack | null } | null;
}

/** What the page's own player is doing, read locally and without a round trip. */
export interface LocalState {
  playing: boolean;
  progressMs: number;
  /** True while the track is still being fetched, when `progressMs` means
      nothing: it is interpolated from a standing event. */
  loading: boolean;
  /** Both forms of the current track, so a relinked one still matches. */
  uris: string[];
}

interface ReadyPayload {
  device_id: string;
}

interface ErrorPayload {
  message: string;
}

interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  activateElement?(): Promise<void>;
  getCurrentState(): Promise<SdkState | null>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  addListener(event: 'ready' | 'not_ready', cb: (payload: ReadyPayload) => void): boolean;
  addListener(
    event: 'initialization_error' | 'authentication_error' | 'account_error' | 'playback_error',
    cb: (payload: ErrorPayload) => void,
  ): boolean;
  addListener(event: 'player_state_changed', cb: (payload: SdkState | null) => void): boolean;
}

type SdkPlayerCtor = new (options: {
  name: string;
  getOAuthToken: (cb: (token: string) => void) => void;
  volume?: number;
}) => SdkPlayer;

declare global {
  interface Window {
    Spotify?: { Player: SdkPlayerCtor };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

@Injectable({ providedIn: 'root' })
export class SpotifySdk {
  private readonly auth = inject(SpotifyAuth);

  /** The live device id, or empty while the player is not ready. */
  readonly deviceId = signal('');

  /** Set only for faults that mean the player will never work on this device. */
  readonly error = signal('');

  readonly ready = computed(() => this.deviceId() !== '');

  private player: SdkPlayer | null = null;
  private starting: Promise<void> | null = null;

  /**
   * The SDK refuses to run without `streaming`, and a refreshed token keeps
   * the scopes of the original consent — so an old login silently lacks it
   * and the only cure is reconnecting.
   */
  supported(): boolean {
    return this.auth.grantedScopes().includes('streaming');
  }

  /** Idempotent: safe to call on every visit to Play. */
  load(): Promise<void> {
    this.starting ??= this.create().catch((error: unknown) => {
      const why = error instanceof Error ? error.message : String(error);
      log('sdk', 'load-failed', { why });
      this.error.set(why);
      // Cleared so a later visit can retry rather than being stuck on one
      // bad network moment.
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Unblocks audio. Mobile browsers refuse sound that no gesture asked for,
   * and the play command arrives much later over the network, so this has to
   * run inside the tap itself — never after an await of something else.
   */
  async activate(): Promise<void> {
    if (!this.player?.activateElement) return;
    try {
      await this.player.activateElement();
      log('sdk', 'activated', {});
    } catch (error) {
      log('sdk', 'activate-failed', {
        why: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The device id once the player is ready. Resolves empty when it never
   * arrives, which the caller must treat as a failure rather than falling
   * back to the last active device — that is the suspended phone app.
   */
  async waitForDevice(timeoutMs = 3000): Promise<string> {
    if (this.deviceId()) return this.deviceId();
    void this.load();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (this.deviceId()) return this.deviceId();
      if (this.error()) return '';
    }
    log('sdk', 'wait-timeout', { timeoutMs });
    return '';
  }

  // Local transport. Unlike the Web API these take effect in milliseconds and
  // report the truth, which is what makes a fraction-of-a-second round possible.

  async state(): Promise<LocalState | null> {
    const state = await this.player?.getCurrentState();
    if (!state) return null;
    const track = state.track_window?.current_track;
    return {
      playing: !state.paused,
      progressMs: state.position,
      loading: state.loading === true,
      uris: [track?.uri, track?.linked_from?.uri].filter((uri): uri is string => !!uri),
    };
  }

  async pause(): Promise<void> {
    await this.player?.pause();
  }

  async resume(): Promise<void> {
    await this.player?.resume();
  }

  async seek(positionMs: number): Promise<void> {
    await this.player?.seek(Math.max(0, Math.round(positionMs)));
  }

  private async create(): Promise<void> {
    if (!this.supported()) {
      throw new Error(
        'Verbind opnieuw met Spotify in Instellingen om de speler in de app te gebruiken.',
      );
    }

    await this.loadScript();

    const Ctor = window.Spotify?.Player;
    if (!Ctor) throw new Error('De Spotify-speler kon niet worden geladen.');

    const player = new Ctor({
      name: PLAYER_NAME,
      // Asked for again whenever it expires, so the token must be fetched
      // each time rather than captured once.
      getOAuthToken: (cb) => {
        void this.auth.token().then(cb);
      },
      // Full scale: this is a party game, and the handset's own volume keys
      // are the control anyone will actually reach for.
      volume: 1,
    });

    player.addListener('ready', ({ device_id }) => {
      log('sdk', 'ready', { deviceId: device_id.slice(0, 8) });
      this.error.set('');
      this.deviceId.set(device_id);
    });

    player.addListener('not_ready', ({ device_id }) => {
      log('sdk', 'not-ready', { deviceId: device_id.slice(0, 8) });
      this.deviceId.set('');
    });

    // Only these two mean the player is never going to work here. An
    // authentication_error is raised during the handshake even on a token
    // that then goes on to reach `ready` and play, so treating it as fatal
    // would break the app on a login that is actually fine.
    player.addListener('initialization_error', ({ message }) => {
      log('sdk', 'initialization-error', { message });
      this.error.set('Deze browser kan geen muziek afspelen. Kies een apparaat in Instellingen.');
    });

    player.addListener('account_error', ({ message }) => {
      log('sdk', 'account-error', { message });
      this.error.set('Afspelen in de app vraagt een gewoon Spotify Premium-account.');
    });

    player.addListener('authentication_error', ({ message }) => {
      log('sdk', 'authentication-error', { message });
    });

    player.addListener('playback_error', ({ message }) => {
      log('sdk', 'playback-error', { message });
    });

    // Playback moving to another device is worth a line; the rest of the event
    // stream fires many times a round and was only ever read while tracking
    // down where a track's load window ends.
    player.addListener('player_state_changed', (state) => {
      if (!state) log('sdk', 'state-null', {});
    });

    this.player = player;
    const ok = await player.connect();
    log('sdk', 'connect', { ok });
  }

  private loadScript(): Promise<void> {
    if (window.Spotify) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      // The SDK calls this global when it has finished parsing; there is no
      // other signal, and it fires once per page.
      window.onSpotifyWebPlaybackSDKReady = () => resolve();

      const tag = document.createElement('script');
      tag.src = SCRIPT;
      tag.async = true;
      tag.onerror = () => reject(new Error('De Spotify-speler kon niet worden geladen.'));
      document.head.appendChild(tag);
      log('sdk', 'script-requested', {});
    });
  }
}
