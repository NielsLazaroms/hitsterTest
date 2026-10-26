import { Injectable, inject } from '@angular/core';
import { SpotifyAuth } from './spotify-auth';
import { isDebugEnabled, log, nextSeq } from './debug';
import type { Probe } from './diagnostics';
import type { SpotifyDevice } from './models';

const BASE = 'https://api.spotify.com/v1';

export class SpotifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
  }
}

interface ApiErrorBody {
  error?: { message?: string; reason?: string };
}

@Injectable({ providedIn: 'root' })
export class SpotifyApi {
  private readonly auth = inject(SpotifyAuth);

  async request<T>(path: string, init: RequestInit = {}, allowRetry = true): Promise<T | null> {
    const token = await this.auth.token();
    const url = path.startsWith('http') ? path : BASE + path;

    // Paired "sent"/"done" lines: two commands are often in flight at once and
    // the order they *arrive* in is the thing being diagnosed. The token is
    // never logged.
    const seq = nextSeq();
    const method = init.method ?? 'GET';
    const sentAt = performance.now();
    log('api', 'sent', { seq, method, path, body: init.body ?? undefined });

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch {
      log('api', 'failed', { seq, method, path, ms: performance.now() - sentAt });
      throw new SpotifyError(
        'Kan Spotify niet bereiken. Controleer de verbinding en probeer het opnieuw.',
        0,
      );
    }

    log('api', 'done', {
      seq,
      method,
      path,
      status: response.status,
      ms: performance.now() - sentAt,
    });

    if (response.status === 401 && allowRetry) {
      await this.auth.refresh();
      return this.request<T>(path, init, false);
    }

    if (response.status === 204) return null;

    const text = await response.text();
    const body: unknown = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const err = body as ApiErrorBody | null;
      throw new SpotifyError(
        err?.error?.message ?? `Spotify gaf ${response.status} terug.`,
        response.status,
        err?.error?.reason,
      );
    }

    return body as T;
  }

  /**
   * A read-only request that reports what happened instead of throwing, so a
   * diagnostic can show the status of several endpoints side by side.
   */
  async probe(label: string, path: string): Promise<Probe> {
    const url = path.startsWith('http') ? path : BASE + path;

    let token: string;
    try {
      token = await this.auth.token();
    } catch (error) {
      const why = error instanceof Error ? error.message : 'could not get an access token';
      return { label, path, status: 'no token', ok: false, body: why };
    }

    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const body = await response.text();
      return { label, path, status: response.status, ok: response.ok, body: body || '(empty)' };
    } catch {
      return { label, path, status: 'network error', ok: false, body: 'fetch failed' };
    }
  }

  // ------------------------------------------------------------- playback --

  async devices(): Promise<SpotifyDevice[]> {
    const data = await this.request<{ devices: SpotifyDevice[] }>('/me/player/devices');
    const devices = data?.devices ?? [];
    // Built behind the flag, not passed into log(): mapping the list is real
    // work on a path every Settings visit takes, and Spotify may send a null
    // id for a restricted device, which `SpotifyDevice` does not admit.
    if (isDebugEnabled()) {
      log('api', 'devices', {
        count: devices.length,
        list: devices.map(
          (d) =>
            `${d.name}/${d.type}${d.is_active ? '*' : ''}` +
            `:${(d.id ?? 'no-id').slice(0, 8)}` +
            `:vol${(d as { volume_percent?: number | null }).volume_percent ?? '-'}` +
            `${(d as { is_restricted?: boolean }).is_restricted ? ':restricted' : ''}`,
        ),
      });
    }
    return devices;
  }

  /**
   * What the device is doing right now: whether it says it is playing, and how
   * far into the track it is. A play command is acknowledged well before the
   * device has loaded the track, and `is_playing` flips true just as early, so
   * a timed fragment must watch the position: only an advancing position means
   * audio is actually coming out. Null when there is no active device (204).
   */
  async playbackState(): Promise<{ playing: boolean; progressMs: number } | null> {
    const data = await this.request<{
      is_playing?: boolean;
      progress_ms?: number | null;
      device?: { id?: string | null; name?: string; type?: string } | null;
      item?: { uri?: string } | null;
    }>('/me/player');
    if (!data) {
      // 204: Spotify has no active device at all, which reads very differently
      // from a device that is active but silent.
      log('api', 'state', { active: false });
      return null;
    }
    // Which device Spotify thinks it is playing on, and what. A play aimed at
    // one device moves the session off whatever was playing before, so this is
    // the line that tells "the phone went quiet" apart from "the music moved".
    log('api', 'state', {
      playing: data.is_playing === true,
      progressMs: data.progress_ms ?? 0,
      device: data.device?.name ?? '-',
      deviceId: data.device?.id?.slice(0, 8) ?? '-',
      uri: data.item?.uri ?? '-',
    });
    return { playing: data.is_playing === true, progressMs: data.progress_ms ?? 0 };
  }

  /**
   * The track's length in ms, so the tape counter can stop when the song ends.
   * A scanned card carries only the id, and nothing is stored, so this is looked
   * up live.
   */
  async trackLengthMs(id: string): Promise<number> {
    const data = await this.request<{ duration_ms?: number }>(`/tracks/${encodeURIComponent(id)}`);
    return data?.duration_ms ?? 0;
  }

  /**
   * Starts the track on the device, optionally from a position into it. Also
   * the way to wake a device that has gone quiet: a bare resume is refused
   * once Spotify no longer counts it as active, while a play aimed at its id
   * transfers playback back to it, as long as it is still listed.
   */
  async play(uri: string, deviceId: string | null, positionMs = 0): Promise<void> {
    const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
    // No device id means "wherever Spotify was last active", which is a very
    // different command from one aimed at a device, and indistinguishable
    // after the fact without this line.
    log('api', 'play', {
      uri,
      target: deviceId ? deviceId.slice(0, 8) : 'last-active',
      positionMs,
    });
    try {
      await this.request(`/me/player/play${query}`, {
        method: 'PUT',
        body: JSON.stringify({ uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) }),
      });
    } catch (error) {
      throw translatePlaybackError(error);
    }
  }

  async resume(): Promise<void> {
    await this.request('/me/player/play', { method: 'PUT' });
  }

  async pause(): Promise<void> {
    await this.request('/me/player/pause', { method: 'PUT' });
  }

  async seekToStart(): Promise<void> {
    await this.request('/me/player/seek?position_ms=0', { method: 'PUT' });
  }
}

function translatePlaybackError(error: unknown): Error {
  if (error instanceof SpotifyError) {
    if (error.status === 404 || error.reason === 'NO_ACTIVE_DEVICE') {
      return new Error(
        'Geen Spotify-apparaat gevonden. Open Spotify, speel een seconde iets af en probeer het opnieuw.',
      );
    }
    if (error.status === 403) {
      return new Error('Spotify weigerde het afspelen. Hiervoor is een Premium-account nodig.');
    }
  }
  return error instanceof Error ? error : new Error('Afspelen mislukt.');
}
