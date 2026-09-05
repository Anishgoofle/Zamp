/**
 * `check` and `default` are the only two places where a user's own SQL text ends
 * up inside generated DDL. Everything else in the model is an identifier, and
 * identifiers get double-quoted; an expression cannot be, because the whole point
 * of it is to be SQL.
 *
 * So it is checked instead. This is not a parser and does not try to be — it is a
 * gate that rejects the shapes that let one expression turn into two statements,
 * or into a comment that swallows the rest of the line. Combined with the driver
 * being pinned to the extended query protocol (one statement per call, see
 * `postgres/execute.ts`), an expression that gets through here can compute a
 * value and cannot do anything else.
 *
 * What it deliberately does *not* do is restrict which functions you may call.
 * `now()` and `gen_random_uuid()` are most of the reason people write defaults at
 * all, and an allowlist would be wrong within a week. The trust boundary is
 * therefore: whoever reaches this can evaluate expressions as the connected role.
 * Give it a role that owns its own schema and nothing else — the README says so.
 */

/** Long enough for any real constraint, short enough not to be a payload. */
const MAX_LENGTH = 1000;

/** The problem with `expr`, or null if there isn't one. */
export function checkExpression(expr: string, where: string): string | null {
  if (expr.trim().length === 0) return `${where}: the expression is empty.`;
  if (expr.length > MAX_LENGTH) {
    return `${where}: the expression is ${expr.length} characters; the limit is ${MAX_LENGTH}.`;
  }

  for (const [token, label, why] of FORBIDDEN) {
    if (expr.includes(token)) return `${where}: ${label} is not allowed in an expression — ${why}.`;
  }

  const problem = unbalanced(expr);
  return problem ? `${where}: ${problem}` : null;
}

const FORBIDDEN: ReadonlyArray<readonly [string, string, string]> = [
  [';', '";"', 'it would end this statement and begin another'],
  ['--', '"--"', 'it starts a comment that runs to the end of the line'],
  ['/*', '"/*"', 'it starts a block comment'],
  ['*/', '"*/"', 'it ends a block comment'],
  ['$$', '"$$"', 'it starts a dollar-quoted string, which ignores every other rule here'],
  ['\u0000', 'a NUL byte', 'Postgres cannot store one'],
  ['\\', 'a backslash', 'its meaning depends on server settings this tool does not control'],
];

/**
 * Walk the expression once, tracking whether we are inside a string literal, and
 * report the first thing that does not close. An unbalanced quote or parenthesis
 * is how an expression escapes the `CHECK (...)` that wraps it.
 */
function unbalanced(expr: string): string | null {
  let depth = 0;
  let inString = false;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];

    if (inString) {
      // '' is an escaped quote inside a literal, not the end of one.
      if (ch === "'") {
        if (expr[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }

    if (ch === "'") inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return 'it closes more parentheses than it opens.';
  }

  if (inString) return 'a string literal is never closed.';
  if (depth > 0) return `it leaves ${depth} parenthes${depth === 1 ? 'is' : 'es'} unclosed.`;
  return null;
}
