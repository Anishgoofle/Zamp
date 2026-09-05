import { useCallback, useState } from 'react';
import type { Schema } from '@engine';
import { applySchema, readDatabase } from '../lib/api';
import type { ApplyResponse, Connection, LiveDatabase } from '../lib/api';

type Busy = 'reading' | 'applying' | null;

export interface Database {
  connection: Connection;
  setConnection: (next: Connection) => void;
  live: LiveDatabase | null;
  outcome: ApplyResponse | null;
  busy: Busy;
  error: string | null;
  read: () => void;
  apply: (target: Schema, options: { online: boolean; dryRun: boolean }) => void;
  disconnect: () => void;
}

/**
 * The live-database half of the workbench: read a schema out of Postgres, and push
 * one back. Kept apart from the merge state because the two fail in completely
 * different ways — a merge conflict is something to resolve, a dropped connection
 * is something to retry — and mixing them made both harder to reason about.
 *
 * The connection string lives here and nowhere else. It is not persisted: a
 * password in `localStorage` outlives the tab, the session and the person's
 * memory of having typed it.
 */
export function useDatabase(): Database {
  const [connection, setConnection] = useState<Connection>({ connectionString: '', schema: 'public' });
  const [live, setLive] = useState<LiveDatabase | null>(null);
  const [outcome, setOutcome] = useState<ApplyResponse | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(() => {
    setBusy('reading');
    setError(null);
    readDatabase(connection)
      .then((next) => {
        setLive(next);
        setOutcome(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  }, [connection]);

  const apply = useCallback(
    (target: Schema, options: { online: boolean; dryRun: boolean }) => {
      if (!live) return;
      setBusy('applying');
      setError(null);
      applySchema({ ...connection, target, expect: live.fingerprint, ...options })
        .then((response) => {
          setOutcome(response);
          // A real apply moves the database on, so the schema we hold — and the
          // fingerprint that guards the next apply — have to move with it.
          if (!response.dryRun) {
            setLive({
              schema: response.schema,
              stats: response.stats,
              notes: response.notes,
              fingerprint: response.fingerprint,
              source: response.source,
            });
          }
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setBusy(null));
    },
    [connection, live],
  );

  const disconnect = useCallback(() => {
    setLive(null);
    setOutcome(null);
    setError(null);
  }, []);

  return { connection, setConnection, live, outcome, busy, error, read, apply, disconnect };
}
