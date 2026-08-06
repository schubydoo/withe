/**
 * Opening the database.
 *
 * The pragmas here are not tuning. Two processes share this file — the web
 * server and the sync worker (AD-1) — and each setting below is what makes that
 * safe or recoverable.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.ts';

export class WalUnavailableError extends Error {
  constructor(actual: string, file: string) {
    super(
      `SQLite refused write-ahead logging on ${file} and reported journal_mode='${actual}'. ` +
        `This almost always means the file sits on a network volume (NFS or SMB), where WAL ` +
        `does not work and concurrent access corrupts data. Move WITHE_DB_PATH to local disk.`,
    );
    this.name = 'WalUnavailableError';
  }
}

export function openDatabase(file: string) {
  const sqlite = new Database(file);

  // Must run before any table exists. SQLite cannot change auto_vacuum on a
  // populated database without a full VACUUM, which needs an exclusive lock and
  // free disk equal to the database size. Task 3.7's incremental_vacuum is a
  // no-op without this.
  sqlite.pragma('auto_vacuum = INCREMENTAL');

  sqlite.pragma('journal_mode = WAL');
  const mode = String((sqlite.pragma('journal_mode', { simple: true }) ?? '')).toLowerCase();
  if (mode !== 'wal') {
    sqlite.close();
    throw new WalUnavailableError(mode, file);
  }

  // Two processes, one file. Without this a writer that finds the lock held
  // fails immediately instead of waiting.
  sqlite.pragma('busy_timeout = 5000');
  // With WAL, NORMAL is durable across process crashes and loses only the last
  // transactions on power loss. FULL costs an fsync per commit for a dashboard
  // whose data can be re-read from the source.
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');

  return { sqlite, db: drizzle(sqlite, { schema }) };
}
