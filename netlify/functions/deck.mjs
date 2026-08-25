// Deck sharing backend. A deck built on one device is uploaded here and handed
// back a short code; any other device loads it by typing that code in.
//
// Storage is Netlify Blobs — a free key-value store that lives inside this same
// deploy, so there is no separate service, account, or database to secure. The
// only door to it is this function, which is why the validation below matters:
// POST is an open write endpoint on the public internet.
//
// This is a v2 (ESM) Netlify function: it receives a Web `Request` and returns
// a Web `Response`, and `config.path` gives it the clean /api/deck route.
import { getStore } from '@netlify/blobs';

export const config = { path: '/api/deck' };

/** Same alphabet the app uses for card ids — no look-alike characters. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Guard rails so the endpoint can't be used as a free general file host. */
const MAX_CARDS = 500;
const MAX_BYTES = 1_000_000;

/** Mirror of the client's card guard — a stored blob is untrusted input. */
function isCard(value) {
  return (
    value &&
    typeof value.id === 'string' &&
    typeof value.uri === 'string' &&
    typeof value.title === 'string' &&
    typeof value.artist === 'string' &&
    typeof value.year === 'number'
  );
}

function randomCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < 4; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export default async (req) => {
  const store = getStore('decks');

  if (req.method === 'GET') {
    const code = (new URL(req.url).searchParams.get('code') ?? '').trim().toLowerCase();
    if (!/^[a-z0-9]{4}$/.test(code)) {
      return Response.json({ error: 'Enter a four-character code.' }, { status: 400 });
    }

    const deck = await store.get(code, { type: 'json' });
    if (!deck) {
      return Response.json({ error: 'No deck found for that code.' }, { status: 404 });
    }
    return Response.json(deck);
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'Invalid JSON.' }, { status: 400 });
    }

    // Accept both the shaped payload and a bare card array, so an older client
    // that posts just the cards still works.
    const cards = Array.isArray(body?.cards) ? body.cards : Array.isArray(body) ? body : null;
    const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : 'MIXTAPE';

    if (!cards || cards.length === 0) {
      return Response.json({ error: 'That is not a deck.' }, { status: 400 });
    }
    if (cards.length > MAX_CARDS) {
      return Response.json({ error: `Decks are limited to ${MAX_CARDS} cards.` }, { status: 413 });
    }
    if (!cards.every(isCard)) {
      return Response.json({ error: 'That deck has malformed cards.' }, { status: 400 });
    }

    const payload = { name, cards };
    if (JSON.stringify(payload).length > MAX_BYTES) {
      return Response.json({ error: 'That deck is too large to share.' }, { status: 413 });
    }

    // Try a few random codes. This version of @netlify/blobs has no atomic
    // conditional write (no onlyIfNew), so probe for a free code with a cheap
    // metadata read before writing. The code space is large enough that a
    // collision is rare and the tiny check-then-write race is acceptable here.
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = randomCode();
      if (await store.getMetadata(code)) continue;
      await store.setJSON(code, payload);
      return Response.json({ code });
    }
    return Response.json({ error: 'Could not allocate a code — try again.' }, { status: 503 });
  }

  return Response.json({ error: 'Method not allowed.' }, { status: 405 });
};
