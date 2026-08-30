import { describe, it, expect } from 'vitest';

/**
 * Sanity check: Vitest is wired up and running.
 * Replace / delete once real engine tests land in tests/engine/.
 */
describe('sanity', () => {
  it('runs the test suite', () => {
    expect(1 + 1).toBe(2);
  });
});
