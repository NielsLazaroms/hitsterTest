import { Injectable, inject } from '@angular/core';
import { SpotifyAuth } from './spotify-auth';
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
      throw new SpotifyError('Kan Spotify niet bereiken. Controleer de verbinding en probeer het opnieuw.', 0);
    }

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
    return data?.devices ?? [];
  }

  /**
   * The track's length in ms, so the tape counter can stop when the song ends.
   * A scanned card carries only the id, and nothing is stored, so this is looked
   * up live.
   */
  async trackLengthMs(id: string): Promise<number> {
    const data = await this.request<{ duration_ms?: number }>(
      `/tracks/${encodeURIComponent(id)}`,
    );
    return data?.duration_ms ?? 0;
  }

  async play(uri: string, deviceId: string | null): Promise<void> {
    const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
    try {
      await this.request(`/me/player/play${query}`, {
        method: 'PUT',
        body: JSON.stringify({ uris: [uri] }),
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
