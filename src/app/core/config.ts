/**
 * Build-time settings baked into the deployed app.
 *
 * Safe to commit: a PKCE client id is a public identifier, not a secret (it
 * travels in the query string of every authorize request). Left empty, the app
 * asks for a client id on the setup screen instead.
 */

/** Spotify app Client ID from developer.spotify.com/dashboard. */
export const BUILT_IN_CLIENT_ID = 'c9832add9a7c4313a2e8a1eb614ad2fe';
