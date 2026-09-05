/** A labelled JSON text area for one schema, with its parse/validate error shown inline. */
export function SchemaEditor({
  label,
  text,
  onChange,
  error,
}: {
  label: string;
  text: string;
  onChange: (next: string) => void;
  error: string | null;
}) {
  return (
    <div className={error ? 'editor invalid' : 'editor'}>
      <label>
        <span className="editor-label">{label}</span>
        <textarea
          spellCheck={false}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          rows={18}
        />
      </label>
      {error && <pre className="editor-error">{error}</pre>}
    </div>
  );
}
