import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import { openDatabase } from './client.ts';
import * as schema from './schema.ts';

const dir = mkdtempSync(join(tmpdir(), 'withe-db-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function fresh(name: string) {
  // These tests create the file, so they open as the owner — the role that
  // sets WAL and auto_vacuum. Pages open as readers and never set either.
  return openDatabase(join(dir, `${name}.db`), { role: 'owner' });
}

test('a new database is opened with the pragmas two processes need', () => {
  const { sqlite } = fresh('pragmas');
  assert.equal(sqlite.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(sqlite.pragma('busy_timeout', { simple: true }), 5000);
  assert.equal(sqlite.pragma('synchronous', { simple: true }), 1); // NORMAL
  assert.equal(sqlite.pragma('foreign_keys', { simple: true }), 1);
  sqlite.close();
});

test('auto_vacuum is INCREMENTAL, set before any table exists', () => {
  const { sqlite } = fresh('vacuum');
  // 0 NONE, 1 FULL, 2 INCREMENTAL. Task 3.7's incremental_vacuum is a no-op at
  // anything but 2, and changing it later needs a full VACUUM.
  assert.equal(sqlite.pragma('auto_vacuum', { simple: true }), 2);
  sqlite.close();
});

test('the migration applies and creates the indexes the queries rely on', () => {
  const { sqlite, db } = fresh('migrate');
  migrate(db, { migrationsFolder: './drizzle' });

  const tables = sqlite
    .prepare("select name from sqlite_master where type='table' order by name")
    .all()
    .map((r) => (r as { name: string }).name)
    .filter((n) => !n.startsWith('sqlite_') && !n.startsWith('__drizzle'));
  assert.deepEqual(tables, ['completed_update', 'forge_rate_limit', 'log_problem', 'renovate_run', 'repo', 'source', 'sync_status', 'update']);

  const indexes = sqlite
    .prepare("select name from sqlite_master where type='index' and name is not null")
    .all()
    .map((r) => (r as { name: string }).name);
  for (const required of [
    'repo_source_full',
    'run_source_ext',
    'run_repo_completed',
    'update_natural',
    'completed_natural',
    'completed_repo_closed',
    'problem_run',
    'problem_level',
  ]) {
    assert.ok(indexes.includes(required), `missing index ${required}`);
  }

  // auto_vacuum must survive the migration, which is the whole point of setting
  // it before the tables exist.
  assert.equal(sqlite.pragma('auto_vacuum', { simple: true }), 2);
  sqlite.close();
});

/**
 * The migrations and `schema.ts` describe the same database.
 *
 * They are two files that must agree and nothing made them. A column added to
 * `schema.ts` without regenerating leaves a table the queries address and the
 * migration never creates; a column left in a migration after `schema.ts` drops
 * it is dead in every database, and the next `db:generate` silently emits a
 * table rebuild an unrelated change then carries. Both are quiet until someone
 * regenerates, which is what makes them worth a test rather than a habit.
 *
 * This compares what the migrations actually build against what Drizzle
 * declares, so it reads the real thing rather than the snapshot's copy of it.
 */
test('every migrated table has exactly the columns schema.ts declares', () => {
  const { sqlite, db } = fresh('drift');
  migrate(db, { migrationsFolder: './drizzle' });

  for (const [exportName, table] of Object.entries(schema)) {
    const { name, columns } = getTableConfig(table);
    const declared = columns.map((c) => c.name).sort();
    const built = sqlite
      .prepare(`select name from pragma_table_xinfo(?) order by name`)
      .all(name)
      .map((r) => (r as { name: string }).name);

    assert.deepEqual(built, declared, `${exportName} ('${name}') disagrees with its migration`);
  }
  sqlite.close();
});

test('the drift check can fail: a column no migration creates is caught', () => {
  // The test above is a "nothing differs" assertion, which passes just as well
  // when the comparison reads nothing at all. This proves it compares.
  const { sqlite, db } = fresh('drift-control');
  migrate(db, { migrationsFolder: './drizzle' });
  const built = sqlite
    .prepare(`select name from pragma_table_xinfo('completed_update') order by name`)
    .all()
    .map((r) => (r as { name: string }).name);

  assert.ok(built.length > 0, 'the instrument reads no columns at all');
  assert.ok(built.includes('version_key'), 'a generated column is visible to table_xinfo');
  assert.throws(() => assert.deepEqual([...built, 'not_a_real_column'].sort(), built));
  sqlite.close();
});

test('the unique indexes actually reject duplicates', () => {
  const { sqlite, db } = fresh('unique');
  migrate(db, { migrationsFolder: './drizzle' });

  sqlite.prepare("insert into source (id, kind) values ('home', 'ce')").run();
  const insertRepo = sqlite.prepare(
    "insert into repo (source_adapter_id, org, name, full_name, enabled) values ('home','o','n','o/n', 1)",
  );
  insertRepo.run();
  assert.throws(() => insertRepo.run(), /UNIQUE constraint failed/);

  const insertRun = sqlite.prepare(
    "insert into renovate_run (source_adapter_id, repo_id, external_job_id, status) values ('home', 1, 'job-1', 'success')",
  );
  insertRun.run();
  assert.throws(() => insertRun.run(), /UNIQUE constraint failed/);
  sqlite.close();
});

test('a volume that refuses WAL fails loudly and names the cause', () => {
  // An in-memory database reports journal_mode='memory' and never 'wal', which
  // exercises the same readback that catches an NFS or SMB volume (risk R-14).
  assert.throws(() => openDatabase(':memory:'), {
    name: 'WalUnavailableError',
    message: /journal_mode is 'memory'.*network volume.*WITHE_DB_PATH/s,
  });
});

test('a reader never sets the journal mode, so it cannot race the writer', () => {
  // Prove the split that fixes TR-1: create a WAL file as the owner, then a
  // reader opens it without running the write-locking journal_mode pragma. A
  // reader opening a non-WAL file refuses rather than converting it.
  const { sqlite: owner } = fresh('reader-role');
  owner.close();

  const path = join(dir, 'reader-role.db');
  const { sqlite: reader } = openDatabase(path, { role: 'reader' });
  assert.equal(reader.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(reader.pragma('busy_timeout', { simple: true }), 5000);
  reader.close();
})
