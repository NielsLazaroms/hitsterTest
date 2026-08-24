import { Injectable, computed, inject, signal } from '@angular/core';
import { BUNDLED_DECK_URL } from './config';
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

  /**
   * Loads the deck shipped with the app, for a device that has never built one.
   *
   * The result is deliberately not written to storage: leaving it in memory
   * means a later deploy with an updated deck.json reaches players who never
   * edited their copy, while anyone who imports or builds their own deck
   * overrides it permanently.
   */
  async loadBundled(): Promise<void> {
    if (this.cards().length > 0) return;

    try {
      const response = await fetch(BUNDLED_DECK_URL, { cache: 'no-cache' });
      if (!response.ok) return;

      const parsed: unknown = await response.json();
      if (!Array.isArray(parsed)) return;

      const cards = parsed.filter(isCard);
      if (cards.length) this.cards.set(cards);
    } catch {
      /* no deck shipped, or it is unreadable — the app starts empty as before */
    }
  }

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

  /**
   * Uploads the current deck to the sharing backend and returns a short code
   * another device can load it by. Only works on the deployed site: the
   * /api/deck function does not exist under `ng serve`.
   */
  async share(): Promise<string> {
    let response: Response;
    try {
      response = await fetch('/api/deck', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: this.deckName(), cards: this.cards() }),
      });
    } catch {
      throw new Error('Sharing needs the deployed site — it is unavailable in local preview.');
    }

    const data: unknown = await response.json().catch(() => null);
    const code = (data as { code?: string; error?: string } | null);
    if (!response.ok || !code?.code) {
      throw new Error(code?.error ?? 'Could not share the deck.');
    }
    return code.code;
  }

  /**
   * Fetches a shared deck by code and replaces the local deck with it. Every
   * card is re-checked because a stored deck is untrusted input.
   */
  async loadShared(code: string): Promise<number> {
    const clean = code.trim().toLowerCase();
    if (!/^[a-z0-9]{4}$/.test(clean)) {
      throw new Error('A code is four characters, e.g. k7qf.');
    }

    let response: Response;
    try {
      response = await fetch(`/api/deck?code=${encodeURIComponent(clean)}`);
    } catch {
      throw new Error('Could not reach the deck server.');
    }

    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error((data as { error?: string } | null)?.error ?? 'Could not load that code.');
    }

    const payload = data as { name?: unknown; cards?: unknown } | null;
    const cards = Array.isArray(payload?.cards) ? payload.cards.filter(isCard) : [];
    if (!cards.length) throw new Error('That code did not return a usable deck.');

    this.save(cards);
    if (typeof payload?.name === 'string' && payload.name) this.setDeckName(payload.name);
    return cards.length;
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

/** Guards against a malformed deck.json quietly producing unplayable cards. */
function isCard(value: unknown): value is Card {
  const card = value as Partial<Card> | null;
  return (
    typeof card?.id === 'string' &&
    typeof card.uri === 'string' &&
    typeof card.title === 'string' &&
    typeof card.artist === 'string' &&
    typeof card.year === 'number'
  );
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
