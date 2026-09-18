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

import { openDatabase, type Db } from './client.ts';
import { pruneCompletedUpdates, pruneOldRuns } from './persist.ts';
import { completedUpdate, renovateRun, repo, source } from './schema.ts';

const dir = mkdtempSync(join(tmpdir(), 'withe-prune-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const DAY_MS = 24 * 60 * 60 * 1000;
let counter = 0;

/** A database with `count` runs, the newest now and each older by a day. */
function withRuns(count: number) {
  counter += 1;
  const path = join(dir, `p${counter}.db`);
  const { sqlite, db } = openDatabase(path, { role: 'owner' });
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
    // Runs the source has already purged — the only kind retention touches.
    logAvailable: false,
  }));
  // Batched; 20k separate inserts is slow enough to matter in a test.
  for (let i = 0; i < rows.length; i += 500) {
    db.insert(renovateRun).values(rows.slice(i, i + 500)).run();
  }

  // Checkpoint so the measured size is the file, not a file plus a full WAL.
  db.$client.pragma('wal_checkpoint(TRUNCATE)');
  return { path, sqlite, db };
}

function runCount(db: Db): number {
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

test('a run the source still lists is never pruned, however old', () => {
  const { sqlite, db } = withRuns(0);
  // Ancient, but log_available = 1: the source reports it every cycle, so
  // deleting it would only make the next sync re-insert it under a new id.
  db.insert(renovateRun)
    .values({
      sourceAdapterId: 'default',
      repoId: 1,
      externalJobId: 'still-listed',
      status: 'success',
      completedAt: new Date(Date.now() - 400 * DAY_MS),
      logAvailable: true,
    })
    .run();

  const deleted = pruneOldRuns(db, new Date());
  assert.equal(deleted, 0);
  assert.equal(runCount(db), 1);
  sqlite.close();
});

test('a run whose timestamps are all null is kept, not guessed at', () => {
  const { sqlite, db } = withRuns(0);
  db.insert(renovateRun)
    .values({ sourceAdapterId: 'default', repoId: 1, externalJobId: 'timeless', status: 'unknown', logAvailable: false })
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

/**
 * Completed updates share the runs' retention window (B-10). `closedAt` dates a
 * record, and `archivedAt` dates one the forge left undated, so both are covered
 * here: a window that only read `closedAt` would keep an undated row forever.
 */
function addCompleted(db: Db, rows: { pr: number; closedAt: Date | null; archivedAt: Date }[]): void {
  for (const row of rows) {
    db.insert(completedUpdate)
      .values({
        sourceAdapterId: 'default',
        repoId: 1,
        dependencyName: `dep-${row.pr}`,
        currentVersion: '1.0.0',
        targetVersion: '1.1.0',
        updateType: 'minor',
        datasource: 'npm',
        packageName: `dep-${row.pr}`,
        finalState: 'pr-merged',
        prNumber: row.pr,
        closedAt: row.closedAt,
        archivedAt: row.archivedAt,
      })
      .run();
  }
}

function completedCount(db: Db): number {
  return (db.$client.prepare('select count(*) as n from completed_update').get() as { n: number }).n;
}

test('completed updates older than the window are pruned, newer ones kept', () => {
  const { sqlite, db } = withRuns(0);
  const now = Date.now();
  addCompleted(db, [
    { pr: 1, closedAt: new Date(now - 1 * DAY_MS), archivedAt: new Date(now) },
    { pr: 2, closedAt: new Date(now - 40 * DAY_MS), archivedAt: new Date(now) },
    { pr: 3, closedAt: new Date(now - 90 * DAY_MS), archivedAt: new Date(now) },
  ]);

  const deleted = pruneCompletedUpdates(db, new Date(now - 30 * DAY_MS));
  assert.equal(deleted, 2, 'the two past the window');
  assert.equal(completedCount(db), 1);
  sqlite.close();
});

test('a record the forge left undated prunes on the date Withe archived it', () => {
  const { sqlite, db } = withRuns(0);
  const now = Date.now();
  addCompleted(db, [
    // No close date. Without the archived_at fallback this row outlives every
    // window, because a null never compares below a cutoff.
    { pr: 1, closedAt: null, archivedAt: new Date(now - 90 * DAY_MS) },
    { pr: 2, closedAt: null, archivedAt: new Date(now) },
  ]);

  const deleted = pruneCompletedUpdates(db, new Date(now - 30 * DAY_MS));
  assert.equal(deleted, 1, 'the old one, by its archive date');
  assert.equal(completedCount(db), 1);
  sqlite.close();
});

test('pruning completed updates returns space to the disk', () => {
  const { path, sqlite, db } = withRuns(0);
  const now = Date.now();
  addCompleted(
    db,
    Array.from({ length: 20_000 }, (_unused, i) => ({
      pr: i,
      closedAt: new Date(now - (i + 60) * 60_000),
      archivedAt: new Date(now),
    })),
  );
  db.$client.pragma('wal_checkpoint(TRUNCATE)');
  const before = statSync(path).size;

  const deleted = pruneCompletedUpdates(db, new Date(now));
  assert.equal(deleted, 20_000);
  assert.ok(statSync(path).size < before, `file did not shrink: ${before} -> ${statSync(path).size}`);
  sqlite.close();
});

test('with nothing past the window, the completed archive is untouched', () => {
  const { sqlite, db } = withRuns(0);
  const now = Date.now();
  addCompleted(db, [{ pr: 1, closedAt: new Date(now), archivedAt: new Date(now) }]);
  assert.equal(pruneCompletedUpdates(db, new Date(now - 10_000 * DAY_MS)), 0);
  assert.equal(completedCount(db), 1);
  sqlite.close();
});
