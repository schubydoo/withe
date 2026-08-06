import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import type { CollectResult } from '../adapters/types.ts';
import type { RenovateRun, Repo, Update } from '../core/model.ts';
import { isHeld } from '../core/renovate-log.ts';
import { openDatabase } from './client.ts';
import { persist } from './persist.ts';
import { lastSync, lockFileRefreshes, pendingUpdates, repoHealth } from './queries.ts';

const dir = mkdtempSync(join(tmpdir(), 'withe-q-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function fresh() {
  counter += 1;
  const handle = openDatabase(join(dir, `q${counter}.db`));
  migrate(handle.db, { migrationsFolder: './drizzle' });
  return handle;
}

const SOURCE = 'src';

function makeRepo(fullName: string): Repo {
  const [org = '', name = ''] = fullName.split('/');
  return {
    id: `${SOURCE}:${fullName}`,
    org,
    name,
    fullName,
    enabled: true,
    installStatus: 'activated',
    queueName: 'main',
    installedAt: new Date('2026-07-01T00:00:00Z'),
    removedAt: null,
    sourceAdapterId: SOURCE,
  };
}

function makeRun(fullName: string, jobId: string, status: RenovateRun['status'], at: string): RenovateRun {
  return {
    id: `${SOURCE}:${jobId}`,
    repoId: `${SOURCE}:${fullName}`,
    externalJobId: jobId,
    triggerReason: 'schedule-all',
    queuedAt: new Date(at),
    startedAt: new Date(at),
    completedAt: new Date(at),
    status,
    error: status === 'failed' ? 'ExternalHostError: nope' : null,
    artifactErrors: [],
    logLocation: null,
    runnerVersion: '43.280.0',
    sourceAdapterId: SOURCE,
  };
}

function makeUpdate(fullName: string, over: Partial<Update>): Update {
  return {
    id: `${SOURCE}:${fullName}:${over.dependencyName}`,
    repoId: `${SOURCE}:${fullName}`,
    dependencyName: 'left-pad',
    currentVersion: '1.0.0',
    targetVersion: '1.0.1',
    updateType: 'patch',
    state: 'detected',
    pullRequestUrl: null,
    pullRequestNumber: null,
    closedAt: null,
    closeType: null,
    detectedAt: new Date('2026-08-06T17:00:00Z'),
    packageFileCount: 1,
    sourceAdapterId: SOURCE,
    ...over,
  };
}

const FLEET: CollectResult = {
  repos: [makeRepo('acme/widget'), makeRepo('acme/gadget'), makeRepo('acme/quiet')],
  runs: [
    makeRun('acme/widget', 'j1', 'success', '2026-08-06T16:00:00Z'),
    makeRun('acme/widget', 'j2', 'success', '2026-08-06T17:00:00Z'),
    makeRun('acme/gadget', 'j3', 'failed', '2026-08-06T17:00:00Z'),
    makeRun('acme/quiet', 'j4', 'success', '2026-08-06T17:00:00Z'),
  ],
  updates: [
    makeUpdate('acme/widget', { dependencyName: 'astral-sh/uv', packageFileCount: 7, pullRequestNumber: 1199, state: 'pr-open' }),
    makeUpdate('acme/widget', { dependencyName: 'next', currentVersion: '15.0.0', targetVersion: '16.0.0', updateType: 'major' }),
    makeUpdate('acme/gadget', { dependencyName: 'tsx', currentVersion: '0.4.0', targetVersion: '0.5.0', updateType: 'minor' }),
    makeUpdate('acme/gadget', { dependencyName: 'package.json', currentVersion: null, targetVersion: null, updateType: 'lock-file-maintenance' }),
    makeUpdate('acme/widget', { dependencyName: 'uv.lock', currentVersion: null, targetVersion: null, updateType: 'lock-file-maintenance' }),
  ],
  warnings: [],
};

test('a sync writes every entity and records when it happened', () => {
  const { sqlite, db } = fresh();
  const counts = persist(db, SOURCE, 'ce', FLEET, new Date('2026-08-06T17:00:00Z'));

  assert.deepEqual(counts, { repos: 3, runs: 4, updates: 5 });
  const sync = lastSync(db);
  assert.ok(sync.lastSyncAt instanceof Date, 'the first sync must record its time, not only later ones');
  assert.equal(sync.outcome, 'ok');
  sqlite.close();
});

test('the page reads three groups and a lock-file count', () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', FLEET, new Date());

  const updates = pendingUpdates(db);
  assert.equal(updates.length, 3, 'lock-file refreshes must not appear in the listed rows');

  const held = updates.filter((u) => isHeld({ updateType: u.updateType, currentVersion: u.currentVersion }));
  assert.deepEqual(held.map((u) => u.dependencyName).sort(), ['next', 'tsx']);

  const open = updates.filter((u) => u.prNumber !== null && !held.includes(u));
  assert.deepEqual(open.map((u) => u.dependencyName), ['astral-sh/uv']);
  assert.equal(open[0]?.packageFileCount, 7);

  const locks = lockFileRefreshes(db);
  assert.equal(locks.total, 2);
  assert.equal(locks.repos, 2);
  sqlite.close();
});

test('repository health takes the newest run and finds the failing one', () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', FLEET, new Date());

  const health = repoHealth(db);
  assert.equal(health.length, 3);

  const widget = health.find((r) => r.fullName === 'acme/widget');
  assert.equal(widget?.status, 'success', 'the newest run wins, not the first row');
  assert.equal(widget?.completedAt?.toISOString(), '2026-08-06T17:00:00.000Z');

  assert.deepEqual(
    health.filter((r) => r.status !== 'success').map((r) => r.fullName),
    ['acme/gadget'],
  );

  const quiet = health.find((r) => r.fullName === 'acme/quiet');
  assert.equal(quiet?.pendingCount, 0, 'a repository with nothing pending is up to date, not missing');
  sqlite.close();
});

test('a second sync replaces pending updates rather than doubling them', () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', FLEET, new Date());

  // The uv pull request merged; only the major remains.
  const later: CollectResult = {
    ...FLEET,
    updates: [makeUpdate('acme/widget', { dependencyName: 'next', currentVersion: '15.0.0', targetVersion: '16.0.0', updateType: 'major' })],
  };
  persist(db, SOURCE, 'ce', later, new Date());

  const updates = pendingUpdates(db);
  assert.deepEqual(updates.map((u) => u.dependencyName), ['next']);
  assert.equal(lockFileRefreshes(db).total, 0, 'a merged lock-file refresh must disappear');
  sqlite.close();
});

test('re-syncing the same runs does not duplicate rows', () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', FLEET, new Date());
  persist(db, SOURCE, 'ce', FLEET, new Date());

  const health = repoHealth(db);
  assert.equal(health.length, 3, 'repositories were inserted twice');
  assert.equal(pendingUpdates(db).length, 3);
  sqlite.close();
});
