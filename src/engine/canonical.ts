/**
 * Stable JSON string: object keys sorted recursively, array order kept. Backs
 * structural equality (`equal`) and deterministic sort keys. Schema values are
 * plain JSON, so `JSON.stringify` is total here.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function equal(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/**
 * The value form of `canonical`: a deep copy with keys sorted recursively. Used
 * on objects embedded in a `Change` so `JSON.stringify(diff(...))` is byte-stable
 * regardless of the caller's key order.
 */
export function canonicalize<T>(value: T): T {
  return sortKeys(value) as T;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeys(source[key]);
    }
    return sorted;
  }
  return value;
}
