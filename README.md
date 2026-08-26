# Mixtape

A song-timeline party game: printed cards with a QR code on the front and the
answer on the back, and a phone app that plays the track without ever showing
what it is.

Spotify does the playing. The app never streams audio itself — it drives
whatever device your Spotify account is already signed in to (Spotify Connect),
so the music comes out of the speaker while the phone screen shows nothing but
a clock.

## Running it

```bash
npm install     # jsqr + qrcode-generator were added to package.json
npm start       # http://127.0.0.1:5200
```

The dev server is pinned to `127.0.0.1:5200` in `angular.json`.

> **Use `127.0.0.1`, never `localhost`.** Spotify rejects the literal string
> `localhost` in a redirect URI. The app derives its redirect URI from the
> address you loaded it at, so opening `http://localhost:5200` will produce a
> redirect URI Spotify refuses.

## One-time Spotify setup

1. Create an app at <https://developer.spotify.com/dashboard>.
2. Add `http://127.0.0.1:5200/` as a Redirect URI — exactly, trailing slash
   included.
3. Tick **Web API**, save, and copy the Client ID into the app's setup screen.
4. Add every player's Spotify account email under **User Management**.

Development Mode rules, as of 2026: the app owner must hold Spotify Premium,
at most five users can be allow-listed, and everyone playing needs Premium.

## Handing it to someone else

A deployed copy can carry its own Spotify Client ID so the recipient never sees
the dashboard. It lives in `src/app/core/config.ts` and is safe to commit: a
PKCE client id is a public identifier that travels in every authorize URL, which
is the whole point of the flow.

- `BUILT_IN_CLIENT_ID` — set it and the setup screen collapses to a single
  "Connect Spotify" button. A client id entered by hand still overrides it.

This changes only the setup friction, not who may play: Development Mode still
caps the app at five allow-listed Spotify accounts, each needing Premium.

## Using it

The app stores nothing — it is a stateless generator and player. A card's QR
holds the track's raw Spotify id, so scanning it plays the song directly; the
answer is printed on the card back.

- **Make cards** (Settings → Make cards, or the Back button from Play) — paste a
  playlist you own. It flags any track whose album looks like a remaster,
  compilation or live record, because Spotify reports the release date of *that
  pressing*, not of the song. Fix the highlighted years by hand; this is the
  step that decides whether the game works. Then **Make cards** → Print.
- **Print** — a scaled preview of every sheet, front and back, then the print
  dialog. Print double-sided at **100% / actual size** with duplex set to flip
  on the **long edge**. The back sheets are already mirrored to match. There is
  also a **3D tiles (.stl)** export. The QR is version 3 (29×29) at
  error-correction level H, ≈50.9 mm on a 65 mm card.
- **Play** — scan a card, or paste a Spotify track id / link by hand. The song
  plays anonymously; **Reveal** looks the answer up live from Spotify.

Because the QR carries the Spotify id itself, a card is not tied to any domain
and works no matter where the app is deployed — nothing to regenerate. It is
read only by the app's own scanner, not a plain phone camera.

## Layout

```
src/app/core/         services with no UI
  spotify-auth.ts     Authorization Code + PKCE, token refresh
  spotify-api.ts      thin Web API wrapper, friendly error translation
  player.ts           playback state, clock, clip timer
  deck.ts             playlist import + year heuristics (in-memory, no storage)
  scanner.ts          BarcodeDetector with a jsQR fallback
  qr.ts               QR SVG / matrix generation for cards and tiles
src/app/pages/        one folder per screen
```

State lives in `localStorage` under the `mixtape.` prefix: tokens, the chosen
device and the clip length. The cards themselves are never stored — a card's QR
carries everything the game needs.

## When making cards is refused

Spotify removed `GET /playlists/{id}/tracks` in February 2026 and answers the
removed path with a bare `403 Forbidden`, which reads exactly like a
permissions problem and is not one. The builder calls
`GET /playlists/{id}/items` instead, and reads each entry's `item` — the same
change renamed that nested object from `track`.

Past that, a 403 has three unrelated causes and the message does not say
which. The builder puts a **"Work out which one it is"** button under the
error: it asks Spotify a handful of questions one at a time and reads the
answer off the pattern.

- *Every* call refused, including `/me` — the app is not allowed to call the
  Web API for this account. Two dashboard settings do this and the probe cannot
  separate them, so check both: tick **Web API** under "Which API/SDKs are you
  planning to use?", and add the signed-in account under **User Management**.
- `/me` fine, playlists refused — the token is missing the playlist scopes.
  Disconnect and reconnect; a refreshed token keeps the scopes of the original
  consent, so reconnecting is the only way to widen them.
- Only the one playlist refused — Spotify-made lists (Top 50, Discover Weekly,
  Daily Mix, decade and genre playlists) are closed to third-party apps. Copy
  the tracks into a playlist of your own.

Signing in successfully does not prove much on its own — a Development Mode app
can hand out a token and then refuse every API call.

## Known limits

- **Camera needs a secure context.** `http://127.0.0.1:5200` counts as secure,
  so scanning works on the dev machine. A LAN address like `192.168.x.x` does
  not — on a phone, either deploy over HTTPS or use the typed-code fallback.
- **Premium only.** The Web API refuses playback for free accounts.
- **Spotify must have an active device.** Open Spotify and play anything for a
  second before the first scan, then pick the speaker in Settings.
