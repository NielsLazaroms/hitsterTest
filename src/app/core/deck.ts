import { Injectable, computed, inject, signal } from '@angular/core';
import { SpotifyApi, SpotifyError } from './spotify-api';
import { read, write } from './storage';
import type { Card, DraftCard } from './models';

/**
 * Album titles that almost always mean the release date Spotify reports is not
 * the year the song came out. These are the rows worth checking by hand.
 */
const REISSUE =
  /remaster|anniversar|deluxe|greatest hits|best of|collection|essential|reissue|expanded|live at|live in|the hits|platinum|ultimate|soundtrack/i;

/** Alphabet without look-alike characters, so a card id can be typed by hand. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

interface PlaylistPage {
  items: PlaylistEntry[];
  next: string | null;
}

/**
 * Spotify renamed this nested object from `track` to `item` in February 2026
 * and kept `track` as a deprecated alias. Read whichever one arrives.
 */
interface PlaylistEntry {
  item?: SpotifyTrack | null;
  track?: SpotifyTrack | null;
}

interface SpotifyTrack {
  uri: string;
  name: string;
  artists: { name: string }[];
  album?: { name: string; release_date: string; release_date_precision: string };
}

@Injectable({ providedIn: 'root' })
export class DeckService {
  private readonly api = inject(SpotifyApi);

  readonly cards = signal<Card[]>(read<Card[]>('deck', []));
  readonly count = computed(() => this.cards().length);

  readonly deckName = signal<string>(read<string>('deckName', 'MIXTAPE'));

  find(id: string): Card | undefined {
    const needle = id.trim().toLowerCase();
    return this.cards().find((card) => card.id === needle);
  }

  save(cards: Card[]): void {
    this.cards.set(cards);
    write('deck', cards);
  }

  setDeckName(name: string): void {
    this.deckName.set(name);
    write('deckName', name);
  }

  /** Pulls a playlist and turns it into draft cards awaiting a year review. */
  async fromPlaylist(playlistUrl: string): Promise<DraftCard[]> {
    const match = /playlist[/:]([A-Za-z0-9]+)/.exec(playlistUrl);
    if (!match) throw new Error('That does not look like a Spotify playlist link.');

    /*
     * /tracks was removed in February 2026 in favour of /items, and Spotify
     * answers the removed path with a bare 403 that reads like a permissions
     * problem rather than a gone one. The same change renamed each entry's
     * nested object from track to item.
     *
     * Both spellings are asked for on purpose: the reference docs still use
     * `track` in their own fields example while calling it deprecated, so it is
     * not certain `item` is accepted as a selector yet. Requesting both means
     * whichever one Spotify honours arrives, rather than a silently empty deck.
     */
    const trackFields = 'uri,name,album(name,release_date,release_date_precision),artists(name)';
    const fields = `items(item(${trackFields}),track(${trackFields})),next`;
    let next: string | null =
      `https://api.spotify.com/v1/playlists/${match[1]}/items?limit=50&fields=${encodeURIComponent(fields)}`;

    const drafts: DraftCard[] = [];

    while (next && drafts.length < 300) {
      let page: PlaylistPage | null;
      try {
        page = await this.api.request<PlaylistPage>(next);
      } catch (error) {
        throw explainPlaylistError(error);
      }
      if (!page) break;

      for (const entry of page.items ?? []) {
        const track = entry.item ?? entry.track;
        if (!track?.uri || track.uri.startsWith('spotify:local')) continue;
        // A playlist can hold podcast episodes, which carry no album and so no
        // release year to place on a timeline.
        if (!track.album) continue;

        const year = Number.parseInt((track.album.release_date ?? '').slice(0, 4), 10);
        drafts.push({
          id: cardId(track.uri),
          uri: track.uri,
          title: track.name,
          artist: track.artists.map((a) => a.name).join(', '),
          year: Number.isFinite(year) ? year : null,
          album: track.album.name ?? '',
          suspect:
            REISSUE.test(track.album.name ?? '') || track.album.release_date_precision !== 'day',
        });
      }

      next = page.next;
    }

    return dedupe(drafts);
  }
}

/**
 * Turns a raw Spotify failure into a message that names the likely fix. A 403
 * on a playlist is almost always a scope or access problem rather than a bad
 * link, and the three causes below need three different actions.
 */
function explainPlaylistError(error: unknown): Error {
  if (error instanceof SpotifyError && error.status === 403) {
    const detail = [error.message, error.reason && `reason: ${error.reason}`]
      .filter(Boolean)
      .join(' — ');
    return new Error(
      'Spotify refused this playlist (403). Likely one of: ' +
        '(1) your login is missing playlist permissions — sign out in Settings and reconnect; ' +
        '(2) your Spotify app has not enabled the Web API — in the developer dashboard, edit the app and tick "Web API" under "Which API/SDKs are you planning to use?"; ' +
        '(3) your Spotify app is in Development Mode and this account is not added under User Management in the developer dashboard.' +
        (detail ? ` [Spotify said: ${detail}]` : ''),
    );
  }
  if (error instanceof SpotifyError && error.status === 404) {
    return new Error(
      'Spotify could not find that playlist (404). Check the link, and note that ' +
        'Spotify-owned editorial or algorithmic playlists (Discover Weekly, Daily Mix, etc.) ' +
        'are not readable by third-party apps — use a normal user playlist instead.',
    );
  }
  if (error instanceof SpotifyError) {
    return new Error(`Spotify returned ${error.status}: ${error.message}`);
  }
  return error instanceof Error ? error : new Error('Could not read that playlist.');
}

/** Stable 4-character id derived from the track URI (FNV-1a). */
export function cardId(seed: string): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  let n = hash >>> 0;
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += ALPHABET[n % ALPHABET.length];
    n = Math.floor(n / ALPHABET.length);
  }
  return out;
}

function dedupe(drafts: DraftCard[]): DraftCard[] {
  const seen = new Set<string>();
  for (const draft of drafts) {
    while (seen.has(draft.id)) draft.id = cardId(draft.id + '.');
    seen.add(draft.id);
  }
  return drafts;
}
