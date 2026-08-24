import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Drives the deck-sharing function with real Request objects against an
 * in-memory stand-in for Netlify Blobs, so the request/validation/code-gen
 * logic is exercised without a deploy. Only the real blob persistence — which
 * is Netlify's — is stubbed.
 */
const store = new Map<string, unknown>();

vi.mock('@netlify/blobs', () => ({
  getStore: () => ({
    async setJSON(key: string, value: unknown, opts?: { onlyIfNew?: boolean }) {
      if (opts?.onlyIfNew && store.has(key)) return { modified: false };
      store.set(key, value);
      return { modified: true };
    },
    async get(key: string) {
      return store.has(key) ? store.get(key) : null;
    },
  }),
}));

const { default: handler } = await import('../netlify/functions/deck.mjs');

const card = { id: 'a3f9', uri: 'spotify:track:x', title: 'Song', artist: 'Band', year: 1999 };
const post = (body: unknown) =>
  handler(new Request('https://x/api/deck', { method: 'POST', body: JSON.stringify(body) }));
const get = (code: string) => handler(new Request(`https://x/api/deck?code=${code}`));

describe('deck sharing function', () => {
  beforeEach(() => store.clear());

  it('stores a deck and returns a 4-char code, then reads it back', async () => {
    const res = await post({ name: 'MYMIX', cards: [card] });
    expect(res.status).toBe(200);
    const { code } = await res.json();
    expect(code).toMatch(/^[a-z0-9]{4}$/);

    const read = await get(code);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ name: 'MYMIX', cards: [card] });
  });

  it('accepts a bare card array too', async () => {
    const res = await post([card]);
    expect(res.status).toBe(200);
  });

  it('404s an unknown code and 400s a malformed one', async () => {
    expect((await get('zzzz')).status).toBe(404);
    expect((await get('!!')).status).toBe(400);
  });

  it('rejects non-decks and malformed cards', async () => {
    expect((await post({ cards: [] })).status).toBe(400);
    expect((await post({ cards: [{ id: 'x' }] })).status).toBe(400);
  });

  it('rejects oversized decks', async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ ...card, id: `c${i}` }));
    expect((await post({ cards: many })).status).toBe(413);
  });

  it('never clobbers an existing code (onlyIfNew)', async () => {
    store.set('k7qf', { name: 'OLD', cards: [card] });
    // Force every generated code to collide with the taken one, then free.
    const codes = ['k7qf', 'k7qf', 'newx'];
    let i = 0;
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((arr) => {
      const c = codes[Math.min(i++, codes.length - 1)];
      const alpha = 'abcdefghjkmnpqrstuvwxyz23456789';
      const u = arr as Uint8Array;
      for (let j = 0; j < 4; j++) u[j] = alpha.indexOf(c[j]);
      return arr;
    });
    const res = await post({ name: 'NEW', cards: [card] });
    spy.mockRestore();
    expect((await res.json()).code).toBe('newx');
    expect(store.get('k7qf')).toEqual({ name: 'OLD', cards: [card] });
  });
});
