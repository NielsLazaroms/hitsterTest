import { Injectable, inject } from '@angular/core';
import { SpotifyApi } from './spotify-api';
import { REQUIRED_SCOPES, SpotifyAuth } from './spotify-auth';

/** One raw endpoint result — status and body, never thrown. */
export interface Probe {
  label: string;
  path: string;
  status: number | 'no token' | 'network error';
  ok: boolean;
  body: string;
}

/**
 * Reads a handful of endpoints one at a time so a 403 can be attributed.
 *
 * The causes of a bare "403 Forbidden" need different fixes and the message
 * alone cannot tell them apart, but the *pattern* across endpoints narrows it:
 *
 *   every call 403           → the app itself has no Web API access, or this
 *                              account is not allow-listed on it
 *   /me works, playlists 403 → the token is missing playlist scopes
 *   only this playlist 403   → the playlist is not readable by third-party apps
 */
@Injectable({ providedIn: 'root' })
export class Diagnostics {
  private readonly api = inject(SpotifyApi);
  private readonly auth = inject(SpotifyAuth);

  async run(playlistUrl: string): Promise<string> {
    const id = /playlist[/:]([A-Za-z0-9]+)/.exec(playlistUrl)?.[1] ?? null;

    /*
     * Every probe needs an access token, and asking for one can itself renew a
     * stale login. Do that first and once, so a refresh failure shows up as the
     * single fact it is rather than as six identical rows that look like the
     * playlist was refused.
     */
    const login = await this.checkLogin();
    if (!login.ok) {
      return [
        'The stored Spotify login could not be renewed, so nothing could be asked of ' +
          'Spotify at all. This is not about the playlist. Spotify said: ' +
          `"${login.detail}". Do not disconnect yet — that erases the login this check ` +
          'reads. Try again in a minute first; if it keeps failing, then reconnect in Settings.',
        '',
        ...this.context(id),
      ].join('\n');
    }

    const track = 'uri,name,album(name,release_date,release_date_precision),artists(name)';
    const fields = `items(item(${track}),track(${track})),next`;

    const probes: Probe[] = [];
    probes.push(await this.api.probe('who you are', '/me'));
    probes.push(await this.api.probe('your playlists', '/me/playlists?limit=1'));
    probes.push(await this.api.probe('your devices', '/me/player/devices'));
    if (id) {
      probes.push(await this.api.probe('this playlist', `/playlists/${id}`));
      probes.push(await this.api.probe('its items', `/playlists/${id}/items?limit=1`));
      probes.push(
        await this.api.probe(
          'its items, as the builder asks for them',
          `/playlists/${id}/items?limit=1&fields=${encodeURIComponent(fields)}`,
        ),
      );
      // The path this app used until the February 2026 removal. Kept as a probe
      // so a 403 here next to an OK above names the cause outright.
      probes.push(
        await this.api.probe('its tracks (removed 2026 path)', `/playlists/${id}/tracks?limit=1`),
      );
    }

    return [verdict(probes, id), '', ...this.context(id), '', ...report(probes)].join('\n');
  }

  private async checkLogin(): Promise<{ ok: boolean; detail: string }> {
    try {
      const token = await this.auth.token();
      return token
        ? { ok: true, detail: 'renewed' }
        : { ok: false, detail: 'no access token was stored' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unknown failure' };
    }
  }

  private context(playlistId: string | null): string[] {
    const granted = this.auth.grantedScopes();
    const missing = REQUIRED_SCOPES.filter((scope) => !granted.includes(scope));

    return [
      `client id      ${this.auth.clientId() || '(none)'}`,
      `redirect uri   ${this.auth.redirectUri}`,
      `playlist id    ${playlistId ?? '(could not read one out of that link)'}`,
      `scopes held    ${granted.length ? granted.join(' ') : '(unknown — recorded from the next reconnect on)'}`,
      `scopes missing ${missing.length ? missing.join(' ') : 'none'}`,
    ];
  }
}

function report(probes: Probe[]): string[] {
  return probes.flatMap((probe) => [
    `${probe.ok ? 'OK  ' : 'FAIL'} ${String(probe.status).padEnd(13)} ${probe.label}`,
    `          ${probe.path}`,
    `          ${probe.body.slice(0, 600)}`,
  ]);
}

/** Turns the pattern of failures into the one sentence worth acting on. */
function verdict(probes: Probe[], playlistId: string | null): string {
  const by = (label: string) => probes.find((probe) => probe.label === label);
  const me = by('who you are');
  const mine = by('your playlists');
  const items = by('its items');
  const removed = by('its tracks (removed 2026 path)');
  const filtered = by('its items, as the builder asks for them');

  if (me?.status === 'network error')
    return 'Cannot reach Spotify at all — check the connection, or an ad blocker / VPN.';

  if (me?.status === 401)
    return (
      'Spotify rejected the access token even after renewing it. Reconnect in Settings, and ' +
      'check the Client ID there is the one from the app you are actually editing.'
    );

  if (me?.status === 403)
    return (
      'Every Spotify endpoint is refused, including the one that only says who you are. That ' +
      'is not about the playlist — the app itself is not allowed to call the Web API for this ' +
      'account. Two settings in the developer dashboard cause this and both are worth ' +
      'checking: (a) edit the app and tick "Web API" under "Which API/SDKs are you planning ' +
      'to use?"; (b) under User Management, add the Spotify account you are signed in as ' +
      '(the owner counts, other players do not until you add them). Save, then disconnect ' +
      'and reconnect in Settings.'
    );

  if (me?.ok && mine?.status === 403)
    return (
      'Reading who you are works, but reading your playlists is refused — the token is missing ' +
      'the playlist scopes. Disconnect and reconnect in Settings: a renewed token keeps the ' +
      'scopes of the original consent, so reconnecting is the only way to widen them.'
    );

  if (items?.ok && filtered?.ok && !filtered.body.includes('spotify:'))
    return (
      'The endpoint answers, but the field filter the builder uses returns nothing usable — ' +
      'the nested key name is wrong for this account. Read the two "its items" lines below: ' +
      'the unfiltered one shows what Spotify actually calls that object.'
    );

  if (items?.ok && removed && !removed.ok)
    return (
      `Everything works on the current endpoint, and only the old one fails (${removed.status}). ` +
      'Spotify removed /playlists/{id}/tracks in February 2026 and refuses it in a way that ' +
      'reads like a permissions problem. The builder calls /playlists/{id}/items now, so ' +
      'loading the playlist again should just work.'
    );

  if (me?.ok && mine?.ok && items && !items.ok)
    return playlistId
      ? `Your account and scopes are fine; it is this specific playlist (${playlistId}) that ` +
          'Spotify will not hand over. Spotify-made lists (Top 50, Discover Weekly, Daily Mix, ' +
          'decade and genre playlists) are closed to third-party apps. Copy the tracks into a ' +
          'new playlist of your own and use that link.'
      : 'That link did not contain a playlist id.';

  if (probes.every((probe) => probe.ok)) return 'Everything answered. Try loading the deck again.';

  return 'Mixed results — the lines below say which call failed and what Spotify replied.';
}
