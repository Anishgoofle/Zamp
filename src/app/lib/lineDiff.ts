/**
 * Which lines of `after` are new relative to `before`. Drives the green gutter on
 * the merged schema.
 *
 * The obvious implementation is a full LCS table, and it's the wrong one here: it
 * costs O(N·M) in memory as well as time. A schema read out of a real database
 * (200 tables serialises to ~56,000 lines of JSON) then asks for a 3-billion-cell
 * matrix and takes the tab down with it.
 *
 * Myers costs O((N+M)·D) in the number of differing lines instead, and D stays
 * small for what this is used on: a merged schema differs from its base by a
 * handful of lines, not half the file. Eugene W. Myers, "An O(ND) Difference
 * Algorithm and Its Variations" (1986), the same greedy walk git diff uses.
 */
export function changedLines(before: string, after: string): Set<number> {
  const a = before.split('\n');
  const b = after.split('\n');
  const changed = new Set<number>();

  // Identical head and tail is the normal case for a schema edit and both are
  // free to find. Shrinking the problem first is what keeps D small.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const left = a.slice(head, a.length - tail);
  const right = b.slice(head, b.length - tail);

  if (right.length === 0) return changed; // pure deletion: nothing in `after` to mark
  if (left.length === 0) {
    for (let i = 0; i < right.length; i++) changed.add(head + i); // pure insertion
    return changed;
  }

  return myers(left, right, head, changed);
}

/**
 * Past this many differing lines the exact answer stops being worth its memory,
 * and stops being worth reading: by then most of the file is highlighted anyway.
 * The cap holds the trace below at ~8MB however far apart the inputs are.
 */
const MAX_EDIT_DISTANCE = 1000;

/**
 * Walk the edit graph one diagonal at a time, keeping the furthest-reaching path
 * on each, until one reaches the far corner. `d` counts edits spent, so the first
 * path to arrive is a shortest one. The saved `trace` is what lets us walk it
 * back afterwards and say which of those edits were insertions.
 */
function myers(a: string[], b: string[], offset: number, changed: Set<number>): Set<number> {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const middle = max; // index of diagonal 0; k ranges -max..max
  const furthest = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(furthest.slice());
    for (let k = -d; k <= d; k += 2) {
      // Reach this diagonal from k+1 by moving down (consuming a line of `b`, an
      // insertion) or from k-1 by moving right (consuming a line of `a`, a
      // deletion). Take whichever is already further along.
      let x =
        k === -d || (k !== d && furthest[middle + k - 1]! < furthest[middle + k + 1]!)
          ? furthest[middle + k + 1]!
          : furthest[middle + k - 1]! + 1;
      let y = x - k;

      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      furthest[middle + k] = x;

      if (x >= n && y >= m) {
        backtrack(trace, middle, n, m, offset, changed);
        return changed;
      }
    }
  }

  markUnmatched(a, b, offset, changed);
  return changed;
}

/**
 * Replay the trace backwards. Each step back is one edit, and the ones that moved
 * `y` without moving `x` are the insertions, which are the lines to highlight.
 */
function backtrack(
  trace: readonly Int32Array[],
  middle: number,
  n: number,
  m: number,
  offset: number,
  changed: Set<number>,
): void {
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0; d--) {
    const furthest = trace[d]!;
    const k = x - y;
    const previousK =
      k === -d || (k !== d && furthest[middle + k - 1]! < furthest[middle + k + 1]!)
        ? k + 1
        : k - 1;
    const previousX = furthest[middle + previousK]!;
    const previousY = previousX - previousK;

    while (x > previousX && y > previousY) {
      x--;
      y--;
    }
    // x === previousX means this edit consumed a line of `b` and none of `a`.
    if (d > 0 && x === previousX) changed.add(offset + previousY);

    x = previousX;
    y = previousY;
  }
}

/**
 * Fallback for texts further apart than MAX_EDIT_DISTANCE. A line of `b` counts as
 * new when `a` has no unspent copy of it: the multiset difference. Ignoring order
 * makes it an approximation, but it's linear and it's right about every line that
 * genuinely has no counterpart.
 */
function markUnmatched(a: string[], b: string[], offset: number, changed: Set<number>): void {
  const unspent = new Map<string, number>();
  for (const line of a) unspent.set(line, (unspent.get(line) ?? 0) + 1);

  for (let i = 0; i < b.length; i++) {
    const remaining = unspent.get(b[i]!) ?? 0;
    if (remaining > 0) unspent.set(b[i]!, remaining - 1);
    else changed.add(offset + i);
  }
}
