/**
 * Opening the database.
 *
 * The pragmas here are not tuning. Two processes share this file — the web
 * server and the sync worker (AD-1) — and each setting below is what makes that
 * safe or recoverable.
 *
 * The connection has a role. The **owner** (the worker and the migrator)
 * creates the file and sets its write-time properties. A **reader** (every
 * page and route) only reads, and must never run a pragma that needs the write
 * lock — that collision, under a 500-repo sync, is risk TR-1, and it is what
 * this split prevents.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.ts';

export class WalUnavailableError extends Error {
  constructor(actual: string, file: string) {
    super(
      `SQLite is not in write-ahead logging mode on ${file}; journal_mode is '${actual}'. ` +
        `This almost always means the file sits on a network volume (NFS or SMB), where WAL ` +
        `does not work and concurrent access corrupts data. Move WITHE_DB_PATH to local disk.`,
    );
    this.name = 'WalUnavailableError';
  }
}

export interface OpenOptions {
  /**
   * `owner` sets the file's write-time properties; only the worker and the
   * migrator open this way. `reader`, the default, never touches a pragma that
   * needs the write lock.
   */
  role?: 'owner' | 'reader';
}

export function openDatabase(file: string, options: OpenOptions = {}) {
  const role = options.role ?? 'reader';
  const sqlite = new Database(file);

  // First, before any pragma that might meet a held lock: wait up to five
  // seconds rather than failing at once. Set late, as it was, a reader's WAL
  // pragma raced the worker's sync and threw 'database is locked' — TR-1, seen
  // in the Task 3.9 load test.
  sqlite.pragma('busy_timeout = 5000');

  if (role === 'owner') {
    // Must run before any table exists. SQLite cannot change auto_vacuum on a
    // populated database without a full VACUUM, which needs an exclusive lock
    // and free disk equal to the database size. Task 3.7's incremental_vacuum
    // is a no-op without this.
    sqlite.pragma('auto_vacuum = INCREMENTAL');
    // Setting the journal mode needs the write lock. Only the owner sets it;
    // there is one owner, so it never contends.
    sqlite.pragma('journal_mode = WAL');
    assertWal(sqlite, file);
  } else {
    // A reader verifies WAL by reading it — a lock-free lookup — rather than
    // setting it. The NFS guard still fires; the contention does not.
    assertWal(sqlite, file);
  }

  // With WAL, NORMAL is durable across process crashes and loses only the last
  // transactions on power loss. FULL costs an fsync per commit for a dashboard
  // whose data can be re-read from the source.
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

/** The database handle `openDatabase` returns. Every query and write takes it. */
export type Db = ReturnType<typeof openDatabase>['db'];

function assertWal(sqlite: Database.Database, file: string): void {
  const mode = String((sqlite.pragma('journal_mode', { simple: true }) ?? '')).toLowerCase();
  if (mode !== 'wal') {
    sqlite.close();
    throw new WalUnavailableError(mode, file);
  }
}
