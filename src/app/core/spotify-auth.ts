import { Injectable, signal } from '@angular/core';
import { BUILT_IN_CLIENT_ID } from './config';
import { read, remove, write } from './storage';

const AUTHORIZE = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';

export const REQUIRED_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
];

const SCOPES = REQUIRED_SCOPES.join(' ');

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

@Injectable({ providedIn: 'root' })
export class SpotifyAuth {
  /**
   * The address Spotify redirects back to, and the address the QR codes encode.
   *
   * Spotify rejects "localhost" outright: during local development the app must
   * be reached at http://127.0.0.1:5200/ and that exact string must be registered
   * as a Redirect URI in the developer dashboard.
   */
  readonly redirectUri = new URL(document.baseURI).toString();

  readonly connected = signal(this.hasRefreshToken());

  /**
   * A stored id wins over the built-in one, so a deployed copy can still be
   * pointed at a different Spotify app from the setup screen.
   */
  clientId(): string {
    return read<string>('clientId', '') || BUILT_IN_CLIENT_ID;
  }

  /** True when the app ships with an id and need not ask for one. */
  hasBuiltInClientId(): boolean {
    return BUILT_IN_CLIENT_ID.length > 0;
  }

  /**
   * The scopes Spotify actually granted, which is not always the set we asked
   * for: a refreshed token keeps the scopes of the original consent, so adding
   * a scope to the list above does nothing until the user reconnects.
   */
  grantedScopes(): string[] {
    return read<string>('scope', '').split(' ').filter(Boolean);
  }

  private hasRefreshToken(): boolean {
    return read<string>('refresh', '').length > 0;
  }

  /** Kicks off the Authorization Code + PKCE flow by navigating to Spotify. */
  async begin(clientId: string): Promise<void> {
    const verifier = randomString(64);
    write('clientId', clientId);
    write('verifier', verifier);

    const challenge = base64Url(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    );

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: SCOPES,
    });

    location.href = `${AUTHORIZE}?${params.toString()}`;
  }

  /** Completes the flow with the ?code= Spotify sent us back. */
  async exchangeCode(code: string): Promise<void> {
    const data = await this.postToken({
      client_id: this.clientId(),
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      code_verifier: read<string>('verifier', ''),
    });
    this.store(data);
    remove('verifier');
  }

  async refresh(): Promise<void> {
    const refreshToken = read<string>('refresh', '');
    if (!refreshToken) throw new Error('Not connected to Spotify.');

    const data = await this.postToken({
      client_id: this.clientId(),
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    this.store(data);
  }

  /** A valid access token, refreshed first if it is about to expire. */
  async token(): Promise<string> {
    if (Date.now() > read<number>('expires', 0)) await this.refresh();
    return read<string>('access', '');
  }

  signOut(): void {
    ['access', 'refresh', 'expires', 'scope'].forEach(remove);
    this.connected.set(false);
  }

  private async postToken(fields: Record<string, string>): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await fetch(TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });
    } catch {
      throw new Error('Cannot reach Spotify. Check your connection and try again.');
    }

    const data = (await response.json()) as TokenResponse;
    if (!response.ok) {
      throw new Error(
        data.error_description ??
          data.error ??
          'Spotify rejected the sign-in. Check the redirect address matches exactly.',
      );
    }
    return data;
  }

  private store(data: TokenResponse): void {
    write('access', data.access_token);
    if (data.refresh_token) write('refresh', data.refresh_token);
    if (data.scope !== undefined) write('scope', data.scope);
    write('expires', Date.now() + (data.expires_in - 60) * 1000);
    this.connected.set(true);
  }
}

function randomString(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function base64Url(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
