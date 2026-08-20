import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import type { CollectResult } from '../adapters/types.ts';
import type { RenovateRun, Repo, Update } from '../core/model.ts';
import { isHeld } from '../core/renovate-log.ts';
import { openDatabase } from './client.ts';
import { persist, recomputeStalled } from './persist.ts';
import { forges, lockFileRefreshes, migrationState, pendingUpdates, repoHealth, repoInventory, runLocation, runsForRepo, triage } from './queries.ts';
import { renovateRun, repo, source } from './schema.ts';

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
    packageFiles: [],
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
    makeUpdate('acme/gadget', { dependencyName: 'package.json', currentVersion: null, targetVersion: null, updateType: 'lock-file-maintenance', packageFiles: ['package.json'] }),
    makeUpdate('acme/widget', { dependencyName: 'uv.lock', currentVersion: null, targetVersion: null, updateType: 'lock-file-maintenance', packageFileCount: 2, packageFiles: ['docs/pyproject.toml', 'pyproject.toml'] }),
  ],
  warnings: [], complete: true,
};

test('a sync writes every entity and records when it happened', () => {
  const { sqlite, db } = fresh();
  const counts = persist(db, SOURCE, 'ce', FLEET, new Date('2026-08-06T17:00:00Z'));

  assert.deepEqual(counts, { repos: 3, runs: 4, updates: 5 });
  // Read the recorded sync straight from the row: persist must stamp the time and
  // outcome on the source, not only count what it wrote.
  const [recorded] = db.all<{ lastSyncAt: number | null; outcome: string | null }>(sql`
    select last_sync_at as lastSyncAt, last_sync_outcome as outcome from source limit 1
  `);
  assert.ok(recorded && recorded.lastSyncAt !== null, 'the first sync must record its time, not only later ones');
  assert.equal(recorded?.outcome, 'ok');
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
  // The manifests come back by name, not only as a count.
  assert.deepEqual(locks.map((l) => l.packageFiles), [
    ['package.json'],
    ['docs/pyproject.toml', 'pyproject.toml'],
  ]);
  sqlite.close();
});

test('a lock-file row written before the paths column reads as no paths', () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', FLEET, new Date());
  // Rows from before migration 0004 hold null; a malformed value must degrade
  // the same way rather than take the page down.
  sqlite.prepare("update \"update\" set package_files = null where dependency_name = 'package.json'").run();
  sqlite.prepare("update \"update\" set package_files = '{not json' where dependency_name = 'uv.lock'").run();

  const locks = lockFileRefreshes(db);
  assert.deepEqual(locks.map((l) => l.packageFiles), [[], []]);
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

  persist(db, SOURCE, 'ce', { repos, runs, updates: [], warnings: [], complete: true }, new Date());

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

test("a removed repository's pending updates disappear with it", () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', FLEET, new Date());

  // The next sync no longer mentions acme/gadget. The others keep their updates.
  persist(db, SOURCE, 'ce', {
    ...FLEET,
    repos: FLEET.repos.filter((r) => r.fullName !== 'acme/gadget'),
    runs: [],
    updates: FLEET.updates.filter((u) => !u.repoId.endsWith('acme/gadget')),
  }, new Date());

  assert.deepEqual(pendingUpdates(db).map((u) => u.dependencyName).sort(), ['astral-sh/uv', 'next']);
  assert.deepEqual(lockFileRefreshes(db).map((l) => l.repoFullName), ['acme/widget']);

  // The rows are deleted, not only filtered: the inventory, which lists
  // removed repositories, must not count updates the source can no longer see.
  const gadget = repoInventory(db).find((r) => r.fullName === 'acme/gadget');
  assert.equal(gadget?.pendingCount, 0);
  sqlite.close();
});

test('stale update rows of an already-removed repository are not listed', () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', FLEET, new Date());
  // A database from before persist cleared these rows: the repository is
  // marked removed but its updates are still there.
  sqlite.prepare("update repo set removed_at = 1 where full_name = 'acme/gadget'").run();

  assert.deepEqual(pendingUpdates(db).map((u) => u.dependencyName).sort(), ['astral-sh/uv', 'next']);
  assert.deepEqual(lockFileRefreshes(db).map((l) => l.repoFullName), ['acme/widget']);
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
  assert.equal(
    pendingUpdates(db).filter((u) => u.sourceAdapterId === 'other').length,
    3,
    "another source's pending updates must survive the removal",
  );
  sqlite.close();
});

test('50 runs come back newest first with what each needs to render', () => {
  const { sqlite, db } = fresh();
  const base = Date.parse('2026-08-06T00:00:00Z');
  const runs = Array.from({ length: 50 }, (_, i) =>
    makeRun('acme/widget', `j${i}`, 'success', new Date(base + i * 3_600_000).toISOString()),
  );
  persist(db, SOURCE, 'ce', { repos: [makeRepo('acme/widget')], runs, updates: [], warnings: [], complete: true }, new Date());

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
  persist(db, SOURCE, 'ce', { repos: [makeRepo('acme/widget')], runs: [queued], updates: [], warnings: [], complete: true }, new Date());

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
  persist(db, SOURCE, 'ce', { repos: [makeRepo('acme/widget')], runs: [run], updates: [], warnings: [], complete: true }, new Date());

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
  persist(db, SOURCE, 'ce', { repos: [makeRepo('acme/widget')], runs, updates: [], warnings: [], complete: true }, new Date());

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
  persist(db, SOURCE, 'ce', { repos: [makeRepo('acme/widget')], runs: [makeRun('acme/widget', 'j1', 'success', '2026-08-06T12:00:00Z')], updates: [], warnings: [], complete: true }, new Date());
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
    warnings: [], complete: true,
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
    warnings: [], complete: true,
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
  persist(db, SOURCE, 'ce', { repos: [makeRepo('acme/broken')], runs, updates: [], warnings: [], complete: true }, new Date());

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
    meta: {
      platform: 'github',
      webBaseUrl: 'https://github.example',
      scheduleCron: null,
      scheduleLastAt: null,
    },
  }, new Date());
  persist(db, 'quiet', 'ce', { repos: [], runs: [], updates: [], warnings: [], complete: true }, new Date());

  const map = forges(db);
  assert.deepEqual(map.get(SOURCE), { platform: 'github', webBaseUrl: 'https://github.example' });
  assert.deepEqual(map.get('quiet'), { platform: null, webBaseUrl: null });
  sqlite.close();
});

test('a clean cycle that reports nothing releases every old run to retention', () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', FLEET, new Date());
  // Every log file was deleted (or the server purged everything): the next
  // clean cycle reports no repos and no runs. The old runs must flip to
  // log-unavailable, or retention stays a permanent no-op at the exact moment
  // the operator's file deletion says it should start.
  persist(db, SOURCE, 'ce', { repos: [], runs: [], updates: [], warnings: [], complete: true }, new Date());

  const available = db.all<{ n: number }>(sql`
    select count(*) as n from renovate_run where log_available = 1
  `);
  assert.equal(available[0]?.n, 0, 'a run a clean cycle did not repeat is gone at the source');
  sqlite.close();
});

test('an incomplete cycle does not grey every log link over a transient outage', () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', FLEET, new Date());
  // The jobs family broke: repos still list, runs are empty, and the adapter
  // says its enumeration was incomplete. Nothing has been purged at the
  // source; the logs must stay offered.
  persist(db, SOURCE, 'ce', {
    repos: FLEET.repos,
    runs: [],
    updates: [],
    warnings: ['Could not read runs for acme/widget: 500'],
    complete: false,
  }, new Date());

  const available = db.all<{ n: number }>(sql`
    select count(*) as n from renovate_run where log_available = 1
  `);
  assert.equal(available[0]?.n, FLEET.runs.length, 'a transient outage must not mark logs gone');
  sqlite.close();
});

test('an incomplete cycle moves no availability at all', () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', FLEET, new Date());
  // acme/widget returned runs but the cycle was incomplete. A partial sweep
  // scoped to widget would still be wrong for a file-backed source, where one
  // repository's runs span files: an unreadable file's runs would grey — and,
  // with retention set, be deleted — because a readable file happened to hold
  // the same repository. So an incomplete cycle asserts nothing.
  persist(db, SOURCE, 'ce', {
    repos: FLEET.repos,
    runs: [makeRun('acme/widget', 'j2', 'success', '2026-08-06T17:00:00Z')],
    updates: [],
    warnings: ['Could not read runs for acme/gadget: 500'],
    complete: false,
  }, new Date());

  const available = db.all<{ n: number }>(sql`
    select count(*) as n from renovate_run where log_available = 1
  `);
  assert.equal(available[0]?.n, FLEET.runs.length, 'nothing greys until the next complete cycle');
  sqlite.close();
});

test('a complete cycle with a benign warning still releases unrepeated runs', () => {
  const { sqlite, db } = fresh();
  persist(db, SOURCE, 'ce', FLEET, new Date());
  // The jsonlog shape of a permanent, harmless warning: a stray text file in
  // the log directory. Enumeration is complete, so retention must keep
  // working — a source that warns every cycle must not pin history forever.
  persist(db, SOURCE, 'ce', {
    repos: [],
    runs: [],
    updates: [],
    warnings: ['stray.log is not JSON Lines; skipped.'],
    complete: true,
  }, new Date());

  const available = db.all<{ n: number }>(sql`
    select count(*) as n from renovate_run where log_available = 1
  `);
  assert.equal(available[0]?.n, 0, 'a benign warning must not block the release');
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

test('runLocation returns null for a run id that does not exist', () => {
  const { sqlite, db } = fresh();
  assert.equal(runLocation(db, 999), null);
  sqlite.close();
});

test('runLocation reports a null instant when the run has no timestamps', () => {
  const { sqlite, db } = fresh();
  db.insert(source).values({ id: SOURCE, kind: 'ce' }).run();
  db.insert(repo)
    .values({ id: 1, sourceAdapterId: SOURCE, org: 'acme', name: 'widget', fullName: 'acme/widget', enabled: true })
    .run();
  // A run with none of completed/started/queued set: coalesce yields null, and
  // runLocation must carry that null through rather than build an invalid Date.
  db.insert(renovateRun)
    .values({ id: 1, sourceAdapterId: SOURCE, repoId: 1, externalJobId: 'j1', status: 'success' })
    .run();

  const location = runLocation(db, 1);
  assert.ok(location);
  assert.equal(location.at, null);
  sqlite.close();
});
