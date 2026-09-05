/**
 * `check` and `default` are the only two places user SQL text reaches generated
 * DDL. Everything else in the model is an identifier, and identifiers get
 * double-quoted. An expression can't be; being SQL is the point of it.
 *
 * So it gets checked instead. Not a parser: a gate that rejects the shapes which
 * turn one expression into two statements, or into a comment that eats the rest
 * of the line. The driver is also pinned to the extended query protocol, one
 * statement per call (see postgres/execute.ts). Between the two, an expression
 * that gets through can compute a value and nothing else.
 *
 * It does not restrict which functions you may call. now() and gen_random_uuid()
 * are most of why people write defaults, and an allowlist would be wrong inside a
 * week. So the trust boundary is: whoever reaches this evaluates expressions as
 * the connected role. Give it a role that owns its schema and nothing else. The
 * README says the same.
 */

/** Long enough for a real constraint, short enough not to be a payload. */
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
 * One pass, tracking whether we're inside a string literal, reporting the first
 * thing that doesn't close. An unbalanced quote or paren is how an expression
 * escapes the CHECK (...) wrapped around it.
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
