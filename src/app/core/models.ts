/** One printed card: a QR id on the front, the answer on the back. */
export interface Card {
  /** Short opaque id encoded in the QR code, e.g. "a3f9". */
  id: string;
  /** Spotify track URI, e.g. "spotify:track:...". */
  uri: string;
  title: string;
  artist: string;
  year: number;
}

/** A card while it is still being reviewed in the deck builder. */
export interface DraftCard extends Omit<Card, 'year'> {
  year: number | null;
  album: string;
  /** True when the release date looks like a reissue rather than the original. */
  suspect: boolean;
}

export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
}
