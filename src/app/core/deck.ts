import { Injectable, computed, inject, signal } from '@angular/core';
import { SpotifyApi, SpotifyError } from './spotify-api';
import type { Card, DraftCard } from './models';

/**
 * Album titles that almost always mean the release date Spotify reports is not
 * the year the song came out. These are the rows worth checking by hand.
 */
const REISSUE =
  /remaster|anniversar|deluxe|greatest hits|best of|collection|essential|reissue|expanded|live at|live in|the hits|platinum|ultimate|soundtrack/i;

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

/**
 * Holds the batch of cards being generated in the current session. The app is
 * stateless — a card's QR carries the raw Spotify track id, and the answer is
 * printed on the card back — so nothing is saved to storage or a backend. The
 * generator fills this in memory; the print page reads it.
 */
@Injectable({ providedIn: 'root' })
export class DeckService {
  private readonly api = inject(SpotifyApi);

  readonly cards = signal<Card[]>([]);
  readonly count = computed(() => this.cards().length);

  /** Replaces the current batch (called by the generator before printing). */
  set(cards: Card[]): void {
    this.cards.set(cards);
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
    // A playlist can list the same track more than once; keep the first and skip
    // the rest, so each unique track is one card.
    const seenUris = new Set<string>();

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
        if (seenUris.has(track.uri)) continue;
        // A playlist can hold podcast episodes, which carry no album and so no
        // release year to place on a timeline.
        if (!track.album) continue;

        seenUris.add(track.uri);
        const year = Number.parseInt((track.album.release_date ?? '').slice(0, 4), 10);
        drafts.push({
          id: trackId(track.uri),
          uri: track.uri,
          title: cleanTitle(track.name),
          artist: track.artists.map((a) => a.name).join(', '),
          year: Number.isFinite(year) ? year : null,
          album: track.album.name ?? '',
          suspect:
            REISSUE.test(track.album.name ?? '') || track.album.release_date_precision !== 'day',
        });
      }

      next = page.next;
    }

    return drafts;
  }
}

/** The bare Spotify id from a `spotify:track:<id>` URI — what the QR encodes. */
export function trackId(uri: string): string {
  return uri.slice(uri.lastIndexOf(':') + 1);
}

/**
 * Strips Spotify's remaster / version / year annotations from a track title, so
 * the card back reads "Bohemian Rhapsody" rather than "Bohemian Rhapsody - 2011
 * Remaster" — and, for a year-guessing game, so a year baked into the title
 * cannot give the answer away.
 *
 * Every bracket group is removed outright (feat. credits, "[Live]", remaster
 * tags), as are ellipses. Trailing dash tails are only dropped when they look
 * like an annotation, so an inline year that is part of the real title (Prince's
 * "1999", "Summer of '69") is left untouched.
 */
export function cleanTitle(name: string): string {
  const ANNOT =
    /remaster(ed)?|re-?master|\bversion\b|\bmix\b|\bedit\b|\bmono\b|\bstereo\b|\b(?:19|20)\d{2}\b/i;
  let t = name;
  // Any bracketed group is dropped — "(feat. X)", "(Remastered)", "[Live]" —
  // none of it belongs on the card face.
  t = t.replace(/\s*[([][^)\]]*[)\]]/g, '');
  // Trailing " - annotation" tails, repeatedly (e.g. "- 2011 - Remaster").
  let prev = '';
  while (prev !== t) {
    prev = t;
    t = t.replace(/\s*[-–—]\s*[^-–—]*$/, (seg) => (ANNOT.test(seg) ? '' : seg));
  }
  // Ellipses ("...", "…") are dropped wherever they appear.
  t = t.replace(/\s*(?:\.{2,}|…)\s*/g, ' ');
  // "&" reads as a comma on the card face ("Us & Them" -> "Us, Them").
  t = t.replace(/\s*&\s*/g, ', ');
  return t.replace(/\s{2,}/g, ' ').trim() || name.trim();
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
      .join('. ');
    return new Error(
      'Spotify weigerde deze afspeellijst (403). Waarschijnlijk een van: ' +
        '(1) je login mist afspeellijst-rechten, dus meld je af in Instellingen en verbind opnieuw; ' +
        '(2) je Spotify-app heeft de Web API niet ingeschakeld: bewerk in het developer dashboard de app en vink "Web API" aan onder "Which API/SDKs are you planning to use?"; ' +
        '(3) je Spotify-app staat in Development Mode en dit account is niet toegevoegd onder User Management in het developer dashboard.' +
        (detail ? ` [Spotify zei: ${detail}]` : ''),
    );
  }
  if (error instanceof SpotifyError && error.status === 404) {
    return new Error(
      'Spotify kon die afspeellijst niet vinden (404). Controleer de link, en let op dat ' +
        'door Spotify beheerde redactionele of algoritmische afspeellijsten (Discover Weekly, Daily Mix, enz.) ' +
        'niet leesbaar zijn voor apps van derden. Gebruik in plaats daarvan een normale gebruikersafspeellijst.',
    );
  }
  if (error instanceof SpotifyError) {
    return new Error(`Spotify gaf ${error.status} terug: ${error.message}`);
  }
  return error instanceof Error ? error : new Error('Kon die afspeellijst niet lezen.');
}
