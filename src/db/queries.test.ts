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
import { persist, recomputeStalled } from './persist.ts';
import { forges, lastSync, lockFileRefreshes, migrationState, pendingUpdates, repoHealth, repoInventory, runsForRepo, triage } from './queries.ts';

const dir = mkdtempSync(join(tmpdir(), 'withe-q-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function fresh() {
  counter += 1;
  const handle = openDatabase(join(dir, `q${counter}.db`), { role: 'owner' });
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
    datasource: 'npm',
    packageName: 'left-pad',
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

test('the page reads three groups and the lock-file refreshes', () => {
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
  assert.equal(locks.length, 2);
  assert.deepEqual(locks.map((l) => l.repoFullName), ['acme/gadget', 'acme/widget']);
  assert.deepEqual(locks.map((l) => l.branchName), ['package.json', 'uv.lock']);
  assert.equal(new Set(locks.map((l) => l.repoFullName)).size, 2);
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
  assert.equal(lockFileRefreshes(db).length, 0, 'a merged lock-file refresh must disappear');
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

test('the inventory carries 40 repositories across 3 organizations', () => {
  const { sqlite, db } = fresh();
  const orgs = ['acme', 'globex', 'initech'];
  const repos = Array.from({ length: 40 }, (_, i) => makeRepo(`${orgs[i % 3]}/repo-${i}`));
  const runs = repos.map((r, i) =>
    makeRun(r.fullName, `j${i}`, i % 7 === 0 ? 'failed' : 'success', '2026-08-06T17:00:00Z'),
  );

  persist(db, SOURCE, 'ce', { repos, runs, updates: [], warnings: [] }, new Date());

  const rows = repoInventory(db);
  assert.equal(rows.length, 40);
  assert.equal(new Set(rows.map((r) => r.org)).size, 3);

  // Sorted by organization then name, so a long list stays scannable.
  const sorted = [...rows].sort((a, b) =>
    a.org === b.org ? (a.name < b.name ? -1 : 1) : a.org < b.org ? -1 : 1,
  );
  assert.deepEqual(rows.map((r) => r.fullName), sorted.map((r) => r.fullName));

  for (const row of rows) {
    assert.ok(row.lastRunAt instanceof Date, `${row.fullName} lost its run time`);
    assert.ok(row.org.length > 0);
    assert.equal(row.removedAt, null);
  }
  assert.equal(rows.filter((r) => r.lastRunStatus === 'failed').length, 6);
  sqlite.close();
});

test('a repository the source stops listing is marked removed, not deleted', () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', FLEET, new Date());
  assert.equal(repoInventory(db).length, 3);

  // The next sync no longer mentions acme/gadget.
  const shrunk = {
    ...FLEET,
    repos: FLEET.repos.filter((r) => r.fullName !== 'acme/gadget'),
    runs: FLEET.runs.filter((r) => !r.repoId.endsWith('acme/gadget')),
    updates: [],
  };
  persist(db, SOURCE, 'ce', shrunk, new Date());

  const rows = repoInventory(db);
  assert.equal(rows.length, 3, 'the row must survive so its history survives');

  const gone = rows.find((r) => r.fullName === 'acme/gadget');
  assert.ok(gone?.removedAt instanceof Date);
  assert.ok(rows.filter((r) => r.fullName !== 'acme/gadget').every((r) => r.removedAt === null));

  // Its runs are still there, which is the reason for keeping the row.
  assert.ok(gone.lastRunAt instanceof Date);
  sqlite.close();
});

test('a repository that comes back is no longer marked removed', () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', FLEET, new Date());
  persist(db, SOURCE, 'ce', { ...FLEET, repos: [FLEET.repos[0]!], runs: [], updates: [] }, new Date());
  assert.equal(repoInventory(db).filter((r) => r.removedAt).length, 2);

  persist(db, SOURCE, 'ce', FLEET, new Date());
  assert.equal(
    repoInventory(db).filter((r) => r.removedAt).length,
    0,
    'reinstalling a repository must clear the mark',
  );
  sqlite.close();
});

test('one source removing a repository does not touch another source', () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', FLEET, new Date());
  persist(db, 'other', 'ce', FLEET, new Date());
  assert.equal(repoInventory(db).length, 6);

  persist(db, SOURCE, 'ce', { ...FLEET, repos: [FLEET.repos[0]!], runs: [], updates: [] }, new Date());
  const removed = repoInventory(db).filter((r) => r.removedAt);
  assert.equal(removed.length, 2);
  assert.ok(removed.every((r) => r.sourceAdapterId === SOURCE), 'sources must not remove each other');
  sqlite.close();
});

test('50 runs come back newest first with what each needs to render', () => {
  const { sqlite, db } = fresh();
  const base = Date.parse('2026-08-06T00:00:00Z');
  const runs = Array.from({ length: 50 }, (_, i) =>
    makeRun('acme/widget', `j${i}`, 'success', new Date(base + i * 3_600_000).toISOString()),
  );
  persist(db, SOURCE, 'ce', { repos: [makeRepo('acme/widget')], runs, updates: [], warnings: [] }, new Date());

  const { runs: rows, total } = runsForRepo(db, 'acme/widget');
  assert.equal(total, 50);
  assert.equal(rows.length, 50);
  assert.deepEqual(rows.map((r) => r.externalJobId).slice(0, 3), ['j49', 'j48', 'j47']);

  for (const row of rows) {
    assert.ok(row.completedAt instanceof Date);
    assert.equal(row.status, 'success');
    assert.equal(row.runnerVersion, '43.280.0');
  }
  sqlite.close();
});

test('a queued run has no duration to report, only a wait', () => {
  const { sqlite, db } = fresh();
  const queued: RenovateRun = {
    ...makeRun('acme/widget', 'q1', 'queued', '2026-08-06T12:00:00Z'),
    startedAt: null,
    completedAt: null,
  };
  persist(db, SOURCE, 'ce', { repos: [makeRepo('acme/widget')], runs: [queued], updates: [], warnings: [] }, new Date());

  const [row] = runsForRepo(db, 'acme/widget').runs;
  assert.equal(row?.status, 'queued');
  assert.equal(row?.startedAt, null);
  assert.equal(row?.completedAt, null);
  assert.ok(row?.queuedAt instanceof Date, 'the wait is measured from here');
});

test('artifact errors survive the round trip and stay separate from the run error', () => {
  const { sqlite, db } = fresh();
  const run: RenovateRun = {
    ...makeRun('acme/widget', 'a1', 'success', '2026-08-06T12:00:00Z'),
    // A run that succeeded and still failed to update a lock file. Folding
    // these into `error` would make it look like the run failed.
    error: null,
    artifactErrors: ['package.json: npm ERR! code ERESOLVE', 'uv.lock'],
  };
  persist(db, SOURCE, 'ce', { repos: [makeRepo('acme/widget')], runs: [run], updates: [], warnings: [] }, new Date());

  const [row] = runsForRepo(db, 'acme/widget').runs;
  assert.equal(row?.status, 'success');
  assert.equal(row?.error, null);
  assert.deepEqual(row?.artifactErrors, ['package.json: npm ERR! code ERESOLVE', 'uv.lock']);
  sqlite.close();
});

test('history pages beyond 200 rows', () => {
  const { sqlite, db } = fresh();
  const base = Date.parse('2026-08-01T00:00:00Z');
  const runs = Array.from({ length: 205 }, (_, i) =>
    makeRun('acme/widget', `j${i}`, 'success', new Date(base + i * 60_000).toISOString()),
  );
  persist(db, SOURCE, 'ce', { repos: [makeRepo('acme/widget')], runs, updates: [], warnings: [] }, new Date());

  const first = runsForRepo(db, 'acme/widget', 0);
  assert.equal(first.total, 205);
  assert.equal(first.runs.length, 200, 'a page is capped');
  assert.equal(first.runs[0]?.externalJobId, 'j204');

  const second = runsForRepo(db, 'acme/widget', 1);
  assert.equal(second.runs.length, 5);
  assert.equal(second.runs[0]?.externalJobId, 'j4');

  // No row appears on both pages.
  const ids = new Set([...first.runs, ...second.runs].map((r) => r.externalJobId));
  assert.equal(ids.size, 205);
  sqlite.close();
});

test('a malformed artifact-errors column does not take the page down', () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', { repos: [makeRepo('acme/widget')], runs: [makeRun('acme/widget', 'j1', 'success', '2026-08-06T12:00:00Z')], updates: [], warnings: [] }, new Date());
  sqlite.prepare("update renovate_run set artifact_errors = '{not json'").run();

  const [row] = runsForRepo(db, 'acme/widget').runs;
  assert.deepEqual(row?.artifactErrors, []);
  sqlite.close();
});

test('triage leads with the failing repositories and how long each has been failing', () => {
  const { sqlite, db } = fresh();
  const hour = 3_600_000;
  const now = Date.parse('2026-08-06T18:00:00Z');

  // widget broke three days ago and has failed hourly since. The age that
  // matters is three days, not one hour.
  const widgetRuns = [
    makeRun('acme/widget', 'w-ok', 'success', new Date(now - 72 * hour).toISOString()),
    ...Array.from({ length: 12 }, (_, i) =>
      makeRun('acme/widget', `w-bad-${i}`, 'failed', new Date(now - (71 - i * 6) * hour).toISOString()),
    ),
  ];

  persist(db, SOURCE, 'ce', {
    repos: [makeRepo('acme/widget'), makeRepo('acme/quiet')],
    runs: [...widgetRuns, makeRun('acme/quiet', 'q1', 'success', new Date(now - hour).toISOString())],
    updates: [],
    warnings: [],
  }, new Date());

  const rows = triage(db);
  const widget = rows.find((r) => r.fullName === 'acme/widget');
  assert.ok(widget);
  assert.equal(widget.lastRunStatus, 'failed');
  assert.ok(widget.lastError);

  const failingForHours = (now - (widget.failingSince?.getTime() ?? now)) / hour;
  assert.ok(
    failingForHours > 60,
    `expected the oldest failure in the run of failures, got ${failingForHours}h`,
  );

  const quiet = rows.find((r) => r.fullName === 'acme/quiet');
  assert.equal(quiet?.failingSince, null, 'a healthy repository has no failing-since');
  sqlite.close();
});

test('a repository with no successful run and no error still surfaces as stalled', () => {
  const { sqlite, db } = fresh();
  const now = Date.parse('2026-08-06T18:00:00Z');
  const old = now - 30 * 24 * 3_600_000;

  // Nothing failed. The last success is simply a month old, which a failure
  // list alone would miss entirely — the case F-04 singles out.
  persist(db, SOURCE, 'ce', {
    repos: [makeRepo('acme/forgotten')],
    runs: [makeRun('acme/forgotten', 'f1', 'success', new Date(old).toISOString())],
    updates: [],
    warnings: [],
  }, new Date());
  recomputeStalled(db, SOURCE, new Date(now - 7 * 24 * 3_600_000));

  const [row] = triage(db);
  assert.ok(row);
  assert.equal(row.stalled, true);
  assert.equal(row.lastRunStatus, 'success', 'no run reported an error');
  assert.equal(row.lastError, null);
  sqlite.close();
});

test('a repository that has never succeeded counts its failures from the first one', () => {
  const { sqlite, db } = fresh();
  const now = Date.parse('2026-08-06T18:00:00Z');
  const runs = Array.from({ length: 5 }, (_, i) =>
    makeRun('acme/broken', `b${i}`, 'failed', new Date(now - (5 - i) * 3_600_000).toISOString()),
  );
  persist(db, SOURCE, 'ce', { repos: [makeRepo('acme/broken')], runs, updates: [], warnings: [] }, new Date());

  const [row] = triage(db);
  assert.ok(row?.failingSince instanceof Date);
  assert.equal(row.failingSince.toISOString(), new Date(now - 5 * 3_600_000).toISOString());
  sqlite.close();
});

test('a removed repository does not appear in triage', () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', FLEET, new Date());
  persist(db, SOURCE, 'ce', { ...FLEET, repos: [FLEET.repos[0]!], runs: [], updates: [] }, new Date());

  const names = triage(db).map((r) => r.fullName);
  assert.deepEqual(names, ['acme/widget'], 'an uninstalled repository is not something to fix');
  sqlite.close();
});

test('forges reports what each source said about its forge, or nulls', () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', {
    ...FLEET,
    meta: { platform: 'github', webBaseUrl: 'https://github.example' },
  }, new Date());
  persist(db, 'quiet', 'ce', { repos: [], runs: [], updates: [], warnings: [] }, new Date());

  const map = forges(db);
  assert.deepEqual(map.get(SOURCE), { platform: 'github', webBaseUrl: 'https://github.example' });
  assert.deepEqual(map.get('quiet'), { platform: null, webBaseUrl: null });
  sqlite.close();
});

test('migrationState counts the applied migrations and dates the newest', () => {
  const { sqlite, db } = fresh();
  const state = migrationState(db);

  assert.ok(state.applied >= 1, 'fresh() applies the committed migrations');
  assert.ok(state.newestAt instanceof Date);
  assert.ok(!Number.isNaN(state.newestAt.getTime()), 'drizzle stores this one in milliseconds');
  sqlite.close();
});
