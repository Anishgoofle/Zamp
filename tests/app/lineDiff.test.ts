import { describe, expect, it } from 'vitest';
import { changedLines } from '../../src/app/lib/lineDiff';

/** Length of the longest common subsequence, the slow and obviously-correct way. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table[0]![0]!;
}

/**
 * A result is correct when it marks as few lines as possible *and* the lines it
 * leaves unmarked really do appear in `before`, in order. Asserting the exact set
 * would be wrong: where several shortest edit scripts exist, Myers may pick a
 * different one from the LCS walk, and both are right.
 */
function check(beforeLines: string[], afterLines: string[]): number[] {
  const changed = changedLines(beforeLines.join('\n'), afterLines.join('\n'));

  // Compare against what the function actually sees. Joining and re-splitting is
  // not a round trip at the edges — `[]` comes back as `['']` — and the oracle has
  // to model the same input or it grades a different question.
  const before = beforeLines.join('\n').split('\n');
  const after = afterLines.join('\n').split('\n');

  expect(changed.size).toBe(after.length - lcsLength(before, after));

  const kept = after.filter((_, i) => !changed.has(i));
  let cursor = 0;
  for (const line of kept) {
    const found = before.indexOf(line, cursor);
    expect(found, `"${line}" is not in the remaining part of before`).toBeGreaterThanOrEqual(0);
    cursor = found + 1;
  }
  // Sorted: `Set` keeps insertion order and the backtrack runs end to start.
  return [...changed].sort((x, y) => x - y);
}

describe('changedLines', () => {
  it('marks nothing when the two are identical', () => {
    expect(check(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([]);
  });

  it('marks an inserted line', () => {
    expect(check(['a', 'c'], ['a', 'b', 'c'])).toEqual([1]);
  });

  it('marks nothing for a pure deletion — the line is not in `after` to mark', () => {
    expect(check(['a', 'b', 'c'], ['a', 'c'])).toEqual([]);
  });

  it('marks a replaced line', () => {
    expect(check(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual([1]);
  });

  it('marks every line when nothing matches', () => {
    expect(check(['a', 'b'], ['x', 'y'])).toEqual([0, 1]);
  });

  it('handles an empty side either way', () => {
    expect(check([''], ['a', 'b'])).toEqual([0, 1]);
    // `['']` is one empty line, and it matches nothing in `before`.
    expect(check(['a', 'b'], [''])).toEqual([0]);
  });

  it('does not mark a moved block twice', () => {
    check(['a', 'b', 'c', 'd'], ['c', 'd', 'a', 'b']);
  });

  it('agrees with a brute-force LCS on random inputs', () => {
    let seed = 12345;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const line = () => String.fromCharCode(97 + Math.floor(random() * 6)); // a small alphabet, so ties abound

    for (let trial = 0; trial < 300; trial++) {
      const before = Array.from({ length: Math.floor(random() * 25) }, line);
      const after = before
        .filter(() => random() > 0.25)
        .flatMap((l) => (random() > 0.8 ? [line(), l] : [l]));
      check(before, after);
    }
  });

  /**
   * The case that used to kill the tab: a schema read out of a real database,
   * edited slightly. The old full-matrix LCS asked for 3 billion cells here.
   */
  it('diffs a 60,000-line schema in milliseconds', () => {
    const before = Array.from({ length: 60_000 }, (_, i) => `      "name": "column_${i}",`);
    const after = [...before];
    for (const at of [10, 20_000, 40_000, 59_000]) after[at] = '      "name": "renamed",';

    const started = performance.now();
    const changed = changedLines(before.join('\n'), after.join('\n'));
    const elapsed = performance.now() - started;

    expect([...changed].sort((x, y) => x - y)).toEqual([10, 20_000, 40_000, 59_000]);
    expect(elapsed).toBeLessThan(500);
  });

  it('stays linear when the two files have nothing in common', () => {
    const before = Array.from({ length: 40_000 }, (_, i) => `old ${i}`);
    const after = Array.from({ length: 40_000 }, (_, i) => `new ${i}`);

    const started = performance.now();
    const changed = changedLines(before.join('\n'), after.join('\n'));
    const elapsed = performance.now() - started;

    // Past MAX_EDIT_DISTANCE it falls back to the multiset difference, which is
    // exactly right here: no line of `after` appears in `before` at all.
    expect(changed.size).toBe(40_000);
    expect(elapsed).toBeLessThan(2_000);
  });
});
