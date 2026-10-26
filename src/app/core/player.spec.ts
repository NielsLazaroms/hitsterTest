import { describe, expect, it } from 'vitest';
import { STEP_LENGTHS, stopDelayMs } from './player';

/**
 * The stop timer is armed more than once per round: when the clock starts,
 * again when the track length arrives, and again on any clip-length change.
 * The first two land within milliseconds of each other on a Hitsnip round, so
 * the arithmetic has to give the same deadline every time it is asked.
 */
describe('stopDelayMs', () => {
  const ROUND_ONE = STEP_LENGTHS[0]; // 0.5 s

  it('waits out the rest of the round when playback has just been confirmed', () => {
    // Confirmed 50 ms into the song, so 450 ms of a 500 ms round is left.
    expect(stopDelayMs(ROUND_ONE, 50, 0, 0)).toBe(450);
  });

  it('does not restart the round when it is armed again a moment later', () => {
    // The regression: the track-length lookup re-arms ~70 ms in. Measured from
    // a whole-second clock that read as "0 s elapsed", so the round was handed
    // its full length a second time — 450 ms here instead of 380.
    expect(stopDelayMs(ROUND_ONE, 50, 70, 0)).toBe(380);
  });

  it('lands on the same deadline however often it is armed', () => {
    // 20 ms into the song, re-armed at 10 ms intervals: each answer plus the
    // time already gone must still point at the same instant.
    const deadlines = [0, 10, 20, 30, 40].map(
      (since) => since + stopDelayMs(ROUND_ONE, 20, since, 0),
    );
    expect(new Set(deadlines)).toEqual(new Set([480]));
  });

  it('counts a resume from where the song is, not from zero', () => {
    // Resumed 10 s into a 30 s clip: 20 s left, not another 30.
    expect(stopDelayMs(30, 10_000, 0, 0)).toBe(20_000);
  });

  it('sends the stop at once when the round is already over', () => {
    // Connect latency routinely exceeded a short round; clamping is what kept
    // the deck moving rather than scheduling a pause in the past.
    expect(stopDelayMs(ROUND_ONE, 800, 0, 0)).toBe(0);
  });

  it('sends the pause one leg early to allow for the trip', () => {
    expect(stopDelayMs(ROUND_ONE, 0, 0, 40)).toBe(460);
  });

  it('gives every rung of the ladder its own length from the top', () => {
    const lengths = STEP_LENGTHS.map((step) => stopDelayMs(step, 0, 0, 0));
    expect(lengths).toEqual([500, 1000, 2000, 4000, 8000, 16_000, 30_000, 60_000]);
  });

  it('keeps the ladder climbing, so no two rounds are the same length', () => {
    const climbing = STEP_LENGTHS.every(
      (step, index) => index === 0 || step > STEP_LENGTHS[index - 1],
    );
    expect(climbing).toBe(true);
  });
});
