import { Injectable, inject } from '@angular/core';
import { SpotifyApi } from './spotify-api';
import { REQUIRED_SCOPES, SpotifyAuth } from './spotify-auth';

/** One raw endpoint result: status and body, never thrown. */
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
        'De opgeslagen Spotify-login kon niet worden vernieuwd, dus er kon Spotify helemaal ' +
          'niets gevraagd worden. Dit gaat niet over de afspeellijst. Spotify zei: ' +
          `"${login.detail}". Koppel nog niet los. Dat wist de login die deze controle ` +
          'leest. Probeer het eerst over een minuut opnieuw; blijft het mislukken, verbind dan opnieuw in Instellingen.',
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
        ? { ok: true, detail: 'vernieuwd' }
        : { ok: false, detail: 'er was geen access-token opgeslagen' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'onbekende fout' };
    }
  }

  private context(playlistId: string | null): string[] {
    const granted = this.auth.grantedScopes();
    const missing = REQUIRED_SCOPES.filter((scope) => !granted.includes(scope));

    return [
      `client id      ${this.auth.clientId() || '(none)'}`,
      `redirect uri   ${this.auth.redirectUri}`,
      `playlist id    ${playlistId ?? '(could not read one out of that link)'}`,
      `scopes held    ${granted.length ? granted.join(' ') : '(unknown, recorded from the next reconnect on)'}`,
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
    return 'Kan Spotify helemaal niet bereiken. Controleer de verbinding, of een adblocker / VPN.';

  if (me?.status === 401)
    return (
      'Spotify weigerde het access-token zelfs na vernieuwen. Verbind opnieuw in Instellingen, en ' +
      'controleer of de Client ID daar die van de app is die je daadwerkelijk bewerkt.'
    );

  if (me?.status === 403)
    return (
      'Elk Spotify-endpoint wordt geweigerd, inclusief het endpoint dat alleen zegt wie je bent. ' +
      'Dat gaat niet over de afspeellijst. De app zelf mag de Web API niet aanroepen voor dit ' +
      'account. Twee instellingen in het developer dashboard veroorzaken dit en beide zijn het ' +
      'controleren waard: (a) bewerk de app en vink "Web API" aan onder "Which API/SDKs are you ' +
      'planning to use?"; (b) voeg onder User Management het Spotify-account toe waarmee je bent ' +
      'ingelogd (de eigenaar telt mee, andere spelers niet totdat je ze toevoegt). Sla op, en ' +
      'koppel daarna los en verbind opnieuw in Instellingen.'
    );

  if (me?.ok && mine?.status === 403)
    return (
      'Lezen wie je bent werkt, maar je afspeellijsten lezen wordt geweigerd. Het token mist ' +
      'de afspeellijst-scopes. Koppel los en verbind opnieuw in Instellingen: een vernieuwd token ' +
      'behoudt de scopes van de oorspronkelijke toestemming, dus opnieuw verbinden is de enige manier om ze te verbreden.'
    );

  if (items?.ok && filtered?.ok && !filtered.body.includes('spotify:'))
    return (
      'Het endpoint antwoordt, maar het veldfilter dat de builder gebruikt levert niets ' +
      'bruikbaars op. De naam van de geneste sleutel klopt niet voor dit account. Lees de twee ' +
      '"its items"-regels hieronder: de ongefilterde toont hoe Spotify dat object werkelijk noemt.'
    );

  if (items?.ok && removed && !removed.ok)
    return (
      `Alles werkt op het huidige endpoint, en alleen het oude faalt (${removed.status}). ` +
      'Spotify verwijderde /playlists/{id}/tracks in februari 2026 en weigert het op een manier ' +
      'die leest als een rechtenprobleem. De builder roept nu /playlists/{id}/items aan, dus ' +
      'de afspeellijst opnieuw laden zou gewoon moeten werken.'
    );

  if (me?.ok && mine?.ok && items && !items.ok)
    return playlistId
      ? `Je account en scopes zijn in orde; het is deze specifieke afspeellijst (${playlistId}) die ` +
          'Spotify niet wil geven. Door Spotify gemaakte lijsten (Top 50, Discover Weekly, Daily Mix, ' +
          'decennium- en genre-afspeellijsten) zijn gesloten voor apps van derden. Kopieer de nummers ' +
          'naar een nieuwe eigen afspeellijst en gebruik die link.'
      : 'Die link bevatte geen afspeellijst-id.';

  if (probes.every((probe) => probe.ok)) return 'Alles antwoordde. Probeer de nummers opnieuw te laden.';

  return 'Gemengde resultaten. De regels hieronder tonen welke aanroep faalde en wat Spotify antwoordde.';
}
