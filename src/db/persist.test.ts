/**
 * Retention pruning (Task 3.7, PRD Section 6.3.1).
 *
 * The load-bearing claim is not "old rows are deleted" but "the file gets
 * smaller", because a delete in a WAL database with incremental auto-vacuum
 * frees pages without returning them to the disk. These tests measure the
 * file, not the row count, for exactly that reason.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { openDatabase } from './client.ts';
import { pruneOldRuns } from './persist.ts';
import { renovateRun, repo, source } from './schema.ts';

const dir = mkdtempSync(join(tmpdir(), 'withe-prune-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const DAY_MS = 24 * 60 * 60 * 1000;
let counter = 0;

/** A database with `count` runs, the newest now and each older by a day. */
function withRuns(count: number) {
  counter += 1;
  const path = join(dir, `p${counter}.db`);
  const { sqlite, db } = openDatabase(path);
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(source).values({ id: 'default', kind: 'ce' }).run();
  db.insert(repo)
    .values({ id: 1, sourceAdapterId: 'default', org: 'acme', name: 'widget', fullName: 'acme/widget', enabled: true })
    .run();

  const now = Date.now();
  const rows = Array.from({ length: count }, (_unused, i) => ({
    sourceAdapterId: 'default',
    repoId: 1,
    externalJobId: `job-${i}`,
    status: 'success' as const,
    completedAt: new Date(now - i * DAY_MS),
  }));
  // Batched; 20k separate inserts is slow enough to matter in a test.
  for (let i = 0; i < rows.length; i += 500) {
    db.insert(renovateRun).values(rows.slice(i, i + 500)).run();
  }

  // Checkpoint so the measured size is the file, not a file plus a full WAL.
  db.$client.pragma('wal_checkpoint(TRUNCATE)');
  return { path, sqlite, db };
}

function runCount(db: ReturnType<typeof openDatabase>['db']): number {
  return (db.$client.prepare('select count(*) as n from renovate_run').get() as { n: number }).n;
}

test('with no retention set, the worker never calls this — but called, it deletes by age', () => {
  const { path, sqlite, db } = withRuns(10);
  // Ten runs, one per day. Keep the last three days.
  const cutoff = new Date(Date.now() - 3 * DAY_MS);
  const deleted = pruneOldRuns(db, cutoff);

  assert.ok(deleted >= 6 && deleted <= 7, `deleted ${deleted}`);
  assert.ok(runCount(db) <= 4);
  // The most recent run is never within reach of a cutoff in the past.
  const newest = (db.$client.prepare('select max(completed_at) as t from renovate_run').get() as { t: number }).t;
  assert.ok(newest * 1000 > cutoff.getTime());
  sqlite.close();
  void path;
});

test('a run whose timestamps are all null is kept, not guessed at', () => {
  const { sqlite, db } = withRuns(0);
  db.insert(renovateRun)
    .values({ sourceAdapterId: 'default', repoId: 1, externalJobId: 'timeless', status: 'unknown' })
    .run();

  const deleted = pruneOldRuns(db, new Date());
  assert.equal(deleted, 0);
  assert.equal(runCount(db), 1);
  sqlite.close();
});

test('pruning returns space to the disk, not just to the free list', () => {
  const { path, sqlite, db } = withRuns(20_000);
  const before = statSync(path).size;

  const deleted = pruneOldRuns(db, new Date(Date.now() - 10_000 * DAY_MS));
  assert.ok(deleted > 9_000, `deleted ${deleted}`);

  const after = statSync(path).size;
  // The whole point of the task: a plain delete leaves this unchanged.
  assert.ok(after < before, `file did not shrink: ${before} -> ${after}`);
  sqlite.close();
});

test('nothing to prune changes nothing, and does not checkpoint for no reason', () => {
  const { path, sqlite, db } = withRuns(50);
  const before = statSync(path).size;
  const deleted = pruneOldRuns(db, new Date(Date.now() - 10_000 * DAY_MS));
  assert.equal(deleted, 0);
  assert.equal(statSync(path).size, before);
  sqlite.close();
});
