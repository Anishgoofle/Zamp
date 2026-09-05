/**
 * Table sizes, for badges and the connection panel.
 *
 * The engine has its own copy of these, because it writes the same numbers into
 * hazard messages and it can't import from `app/`. Two small copies across a
 * boundary that exists on purpose beats a shared module that breaks it.
 */

export function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${n < 10 && unit > 0 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`;
}

/** `~48.0M`. Approximate on purpose — the source is `reltuples`, a planner estimate. */
export function formatRows(rows: number): string {
  if (rows >= 1e9) return `~${(rows / 1e9).toFixed(1)}B`;
  if (rows >= 1e6) return `~${(rows / 1e6).toFixed(1)}M`;
  if (rows >= 1e3) return `~${Math.round(rows / 1e3)}k`;
  return String(rows);
}
