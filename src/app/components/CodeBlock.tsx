import { useMemo, type ReactNode } from 'react';
import { changedLines } from '../lib/lineDiff';

interface Props {
  code: string;
  lang: 'json' | 'sql';
  /** When given (JSON only), lines that differ from this baseline are flagged. */
  baseline?: string;
}

/** A scrollable code block with lightweight token colouring and optional changed-line gutter. */
export function CodeBlock({ code, lang, baseline }: Props) {
  const lines = code.split('\n');
  const tokenize = lang === 'json' ? jsonTokens : sqlTokens;
  // Memoised because the parent re-renders on every keystroke and every pick.
  const changed = useMemo(
    () => (lang === 'json' && baseline != null ? changedLines(baseline, code) : null),
    [lang, baseline, code],
  );

  return (
    <pre className={`code code-${lang}`}>
      <code>
        {lines.map((line, i) => (
          <span key={i} className="code-line" data-changed={changed?.has(i) || undefined}>
            {tokenize(line)}
            {i < lines.length - 1 ? '\n' : ''}
          </span>
        ))}
      </code>
    </pre>
  );
}

function jsonTokens(line: string): ReactNode[] {
  const parts = line.split(/("(?:[^"\\]|\\.)*"\s*:?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?)/g);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith('"')) {
      return (
        <span key={i} className={part.trimEnd().endsWith(':') ? 'tok-key' : 'tok-str'}>
          {part}
        </span>
      );
    }
    if (part === 'true' || part === 'false' || part === 'null') {
      return (
        <span key={i} className="tok-lit">
          {part}
        </span>
      );
    }
    if (/^-?\d/.test(part)) {
      return (
        <span key={i} className="tok-num">
          {part}
        </span>
      );
    }
    return part;
  });
}

const SQL_KEYWORDS = new Set(
  (
    'ALTER TABLE ADD DROP COLUMN CONSTRAINT CREATE RENAME TO TYPE USING SET NOT NULL DEFAULT ' +
    'PRIMARY KEY UNIQUE CHECK FOREIGN REFERENCES'
  ).split(' '),
);

function sqlTokens(line: string): ReactNode[] {
  const parts = line.split(/("[^"]*"|'[^']*'|\b\w+\b)/g);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith('"')) {
      return (
        <span key={i} className="tok-ident">
          {part}
        </span>
      );
    }
    if (part.startsWith("'")) {
      return (
        <span key={i} className="tok-str">
          {part}
        </span>
      );
    }
    if (SQL_KEYWORDS.has(part.toUpperCase())) {
      return (
        <span key={i} className="tok-kw">
          {part}
        </span>
      );
    }
    return part;
  });
}
