/** One printed card: a QR on the front, the answer on the back. */
export interface Card {
  /** The raw 22-char Spotify track id (encoded in the QR), e.g. "4iV5W9uYEdYUVa79Axb7Rh". */
  id: string;
  /** Spotify track URI, e.g. "spotify:track:...". */
  uri: string;
  title: string;
  artist: string;
  year: number;
}

/** A card while it is still being reviewed in the generator. */
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
