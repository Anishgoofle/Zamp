import type { Schema, TableStats } from '@engine';
import type { Connection, LiveDatabase } from '../lib/api';
import { formatBytes, formatRows } from '../lib/format';

/**
 * Connect to a Postgres database and read its schema. Presentational — the
 * connection state and the request live in `useDatabase`.
 */
export function DatabasePanel({
  connection,
  onChange,
  live,
  busy,
  error,
  onRead,
  onUseAsBase,
  onDisconnect,
}: {
  connection: Connection;
  onChange: (next: Connection) => void;
  live: LiveDatabase | null;
  busy: boolean;
  error: string | null;
  onRead: () => void;
  onUseAsBase: (schema: Schema) => void;
  onDisconnect: () => void;
}) {
  return (
    <div className="db">
      <form
        className="db-form"
        onSubmit={(e) => {
          e.preventDefault();
          onRead();
        }}
      >
        <label className="db-field db-url">
          <span className="editor-label">connection string</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="postgres://user:password@host/db — or leave blank to use the server's DATABASE_URL"
            value={connection.connectionString}
            onChange={(e) => onChange({ ...connection, connectionString: e.target.value })}
          />
        </label>
        <label className="db-field">
          <span className="editor-label">schema</span>
          <input
            spellCheck={false}
            value={connection.schema}
            onChange={(e) => onChange({ ...connection, schema: e.target.value })}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Reading…' : live ? 'Re-read' : 'Read schema'}
        </button>
        {live && (
          <button type="button" className="ghost" onClick={onDisconnect}>
            Disconnect
          </button>
        )}
      </form>

      <p className="muted db-hint">
        Never stored — the string stays in this tab and is sent only to this app's own server, which
        holds the connection for the length of one request.
      </p>

      {error && <div className="notice error">{error}</div>}

      {live && (
        <>
          <p className="db-source">
            Connected to <strong>{live.source}</strong>
            <span className="muted">
              {' '}
              · schema <code>{connection.schema}</code> · fingerprint <code>{live.fingerprint}</code>
            </span>
          </p>

          <div className="db-tables">
            {live.schema.tables.length === 0 ? (
              <p className="muted">Connected. The schema is empty — nothing to branch from yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>table</th>
                    <th>columns</th>
                    <th>rows</th>
                    <th>size</th>
                  </tr>
                </thead>
                <tbody>
                  {live.schema.tables.map((t) => (
                    <TableRow key={t.id} name={t.name} columns={t.columns.length} stats={live.stats[t.id]} />
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {live.notes.length > 0 && (
            <details className="db-notes">
              <summary>{live.notes.length} thing(s) this tool doesn't manage</summary>
              <ul>
                {live.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </details>
          )}

          {live.schema.tables.length > 0 && (
            <button type="button" onClick={() => onUseAsBase(live.schema)}>
              Branch from this schema
            </button>
          )}
        </>
      )}
    </div>
  );
}

function TableRow({
  name,
  columns,
  stats,
}: {
  name: string;
  columns: number;
  stats: TableStats | undefined;
}) {
  const big = (stats?.bytes ?? 0) > 1024 ** 3;
  return (
    <tr data-big={big || undefined}>
      <td>{name}</td>
      <td>{columns}</td>
      <td>{stats ? formatRows(stats.rows) : '—'}</td>
      <td>{stats ? formatBytes(stats.bytes) : '—'}</td>
    </tr>
  );
}
