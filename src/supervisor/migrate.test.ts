import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { sql } from 'drizzle-orm';

import { openDatabase } from '../db/client.ts';
import { clearMigrationAttempts, markerPath, migrateOnce, MigrationGaveUpError } from './migrate.ts';

const dir = mkdtempSync(join(tmpdir(), 'withe-mig-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function path(): string {
  counter += 1;
  return join(dir, `m${counter}.db`);
}

test('a new database is migrated and gets no backup', () => {
  const file = path();
  const { backup } = migrateOnce(file, { log: () => {} });

  assert.equal(backup, null, 'there is nothing to back up before the first migration');
  const { sqlite } = openDatabase(file, { role: 'owner' });
  const tables = sqlite
    .prepare("select name from sqlite_master where type='table'")
    .all()
    .map((r) => (r as { name: string }).name);
  assert.ok(tables.includes('repo'));
  sqlite.close();
});

test('an existing database is backed up before migrating', () => {
  const file = path();
  migrateOnce(file, { log: () => {} });

  const { sqlite, db } = openDatabase(file, { role: 'owner' });
  db.run(sql`insert into source (id, kind) values ('src', 'ce')`);
  sqlite.close();

  const { backup } = migrateOnce(file, { log: () => {} });
  assert.ok(backup, 'a second migration must copy the database first');
  assert.ok(existsSync(backup));

  // The copy is a real database, not an empty file.
  const copy = openDatabase(backup, { role: 'owner' });
  const [row] = copy.db.all<{ id: string }>(sql`select id from source`);
  assert.equal(row?.id, 'src');
  copy.sqlite.close();
});

test('three failed migrations write a marker and refuse to try again', () => {
  const file = path();
  const broken = join(dir, 'broken-migrations');
  writeFileSync(join(dir, 'not-a-folder'), '');

  // Point the migrator at a folder that does not exist, which fails every time.
  const attempt = () => migrateOnce(file, { migrationsFolder: broken, maxAttempts: 3, log: () => {} });

  assert.throws(attempt, /attempt 1 of 3/);
  assert.throws(attempt, /attempt 2 of 3/);
  assert.throws(attempt, MigrationGaveUpError);

  const marker = markerPath(file);
  assert.ok(existsSync(marker), 'the third failure must leave something a person can find');
  const text = readFileSync(marker, 'utf8');
  assert.match(text, /migration failed 3 times/);
  assert.match(text, /recover:/);

  // And it must not retry while the marker is there, or the container loops.
  assert.throws(attempt, /Refusing to migrate/);
});

test('the attempt count resets after a success, so old failures do not accumulate', () => {
  const file = path();
  const broken = join(dir, 'still-missing');

  assert.throws(() => migrateOnce(file, { migrationsFolder: broken, maxAttempts: 3, log: () => {} }));
  assert.throws(() => migrateOnce(file, { migrationsFolder: broken, maxAttempts: 3, log: () => {} }));

  clearMigrationAttempts(file);
  migrateOnce(file, { log: () => {} });

  // Two failures happened before; a fresh failure must be attempt one again.
  assert.throws(
    () => migrateOnce(file, { migrationsFolder: broken, maxAttempts: 3, log: () => {} }),
    /attempt 1 of 3/,
  );
});

test('running migrations twice is harmless', () => {
  const file = path();
  migrateOnce(file, { log: () => {} });
  migrateOnce(file, { log: () => {} });

  const { sqlite } = openDatabase(file, { role: 'owner' });
  const count = sqlite
    .prepare("select count(*) as n from sqlite_master where type='table' and name='repo'")
    .get() as { n: number };
  assert.equal(count.n, 1);
  sqlite.close();
});
