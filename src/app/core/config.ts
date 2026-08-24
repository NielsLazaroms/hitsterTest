/**
 * Build-time settings baked into the deployed app.
 *
 * Fill these in before deploying a copy meant for someone else. Both are safe
 * to commit: a PKCE client id is a public identifier, not a secret — it travels
 * in the query string of every authorize request — and the deck gives away
 * nothing that is not already printed on the cards.
 *
 * Left empty, the app behaves as it always has: it asks for a client id on the
 * setup screen and starts with an empty deck.
 */

/** Spotify app Client ID from developer.spotify.com/dashboard. */
export const BUILT_IN_CLIENT_ID = 'c9832add9a7c4313a2e8a1eb614ad2fe';

/**
 * A deck shipped with the app, loaded when the device has none of its own.
 * Put a deck exported from Settings at public/deck.json to use it.
 */
export const BUNDLED_DECK_URL = 'deck.json';
