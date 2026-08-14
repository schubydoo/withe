/**
 * Applying migrations, once, before anything else starts.
 *
 * The supervisor migrates rather than `web` or `worker`, so there is exactly
 * one migrator and no start-order race.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { openDatabase } from '../db/client.ts';

export interface MigrateOptions {
  migrationsFolder?: string;
  maxAttempts?: number;
  log?: (message: string) => void;
}

export class MigrationGaveUpError extends Error {
  readonly marker: string;
  readonly backup: string | null;

  constructor(message: string, marker: string, backup: string | null) {
    super(message);
    this.name = 'MigrationGaveUpError';
    this.marker = marker;
    this.backup = backup;
  }
}

/** Where the give-up marker for a database lives. */
export function markerPath(file: string): string {
  return `${file}.migration-failed`;
}

/**
 * Back up, migrate, and refuse to loop forever on a broken migration.
 *
 * The documented run command uses `--restart unless-stopped`, so a supervisor
 * that simply exits on a bad migration restarts forever with no recovery path.
 * After `maxAttempts` consecutive failures this writes a marker and refuses to
 * try again until a person removes it.
 */
export function migrateOnce(file: string, options: MigrateOptions = {}): { backup: string | null } {
  const folder = options.migrationsFolder ?? './drizzle';
  const maxAttempts = options.maxAttempts ?? 3;
  const log = options.log ?? ((message: string) => console.log(message));
  const marker = markerPath(file);

  if (existsSync(marker)) {
    const detail = readFileSync(marker, 'utf8').trim();
    throw new MigrationGaveUpError(
      `Refusing to migrate: a previous migration failed ${maxAttempts} times and left ` +
        `${marker}. Read it, fix the database, then delete the marker to try again.\n${detail}`,
      marker,
      null,
    );
  }

  const isNew = !existsSync(file);
  let backup: string | null = null;

  if (!isNew) {
    // VACUUM INTO makes a consistent copy without stopping readers. Doing this
    // before every migration rather than only schema-changing ones is cheap for
    // a database this size and removes a judgement call from the hot path.
    backup = join(dirname(file), `${basename(file)}.pre-migration.db`);
    const { sqlite } = openDatabase(file, { role: 'owner' });
    try {
      sqlite.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
      log(`supervisor: backed up ${file} to ${backup}`);
    } catch (cause) {
      // A failed backup must not stop a working install from starting, but the
      // operator should know the safety net is missing.
      backup = null;
      log(`supervisor: could not back up before migrating: ${describe(cause)}`);
    } finally {
      sqlite.close();
    }
  }

  const { sqlite, db } = openDatabase(file, { role: 'owner' });
  try {
    migrate(db, { migrationsFolder: folder });
    log(`supervisor: migrations applied to ${file}`);
    return { backup };
  } catch (cause) {
    const attempts = bumpAttempts(file);
    const message = describe(cause);
    if (attempts >= maxAttempts) {
      writeFileSync(
        marker,
        `${new Date().toISOString()} migration failed ${attempts} times\n` +
          `error: ${message}\n` +
          (backup ? `backup: ${backup}\n` : 'backup: none\n') +
          `recover: restore the backup over ${file}, then delete this file.\n`,
      );
      throw new MigrationGaveUpError(
        `Migration failed ${attempts} times. Wrote ${marker}. ` +
          (backup ? `A backup is at ${backup}.` : 'No backup was made.'),
        marker,
        backup,
      );
    }
    throw new Error(`Migration failed (attempt ${attempts} of ${maxAttempts}): ${message}`);
  } finally {
    sqlite.close();
  }
}

/** Count failures across restarts, since each one is a fresh process. */
function bumpAttempts(file: string): number {
  const path = `${file}.migration-attempts`;
  const previous = existsSync(path) ? Number(readFileSync(path, 'utf8').trim()) : 0;
  const next = Number.isFinite(previous) ? previous + 1 : 1;
  writeFileSync(path, String(next));
  return next;
}

/** Called after a successful start, so a one-off failure does not accumulate. */
export function clearMigrationAttempts(file: string): void {
  const path = `${file}.migration-attempts`;
  if (existsSync(path)) writeFileSync(path, '0');
}

function basename(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
