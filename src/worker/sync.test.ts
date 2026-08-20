import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { sql } from 'drizzle-orm';

import type { CollectResult, SourceAdapter } from '../adapters/types.ts';
import type { RenovateRun, Repo } from '../core/model.ts';
import { openDatabase } from '../db/client.ts';
import { backoffMs, SyncLoop } from './sync.ts';

const dir = mkdtempSync(join(tmpdir(), 'withe-sync-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function fresh() {
  counter += 1;
  const handle = openDatabase(join(dir, `s${counter}.db`), { role: 'owner' });
  migrate(handle.db, { migrationsFolder: './drizzle' });
  return handle;
}

const DAY = 24 * 60 * 60 * 1000;

function repoOf(source: string, fullName: string): Repo {
  const [org = '', name = ''] = fullName.split('/');
  return {
    id: `${source}:${fullName}`,
    org,
    name,
    fullName,
    enabled: true,
    installStatus: 'activated',
    queueName: 'main',
    installedAt: null,
    removedAt: null,
    sourceAdapterId: source,
  };
}

function runOf(source: string, fullName: string, jobId: string, status: RenovateRun['status'], at: number): RenovateRun {
  return {
    id: `${source}:${jobId}`,
    repoId: `${source}:${fullName}`,
    externalJobId: jobId,
    triggerReason: 'schedule-all',
    queuedAt: new Date(at),
    startedAt: new Date(at),
    completedAt: new Date(at),
    status,
    error: null,
    artifactErrors: [],
    logLocation: null,
    runnerVersion: '43.280.0',
    sourceAdapterId: source,
  };
}

/** An adapter whose behaviour each test controls. */
function stub(id: string, behaviour: () => Promise<CollectResult>): SourceAdapter {
  return {
    id,
    kind: 'ce',
    preflight: async () => ({ ok: true, problems: [], reachableButEmpty: false, compose: '' }),
    collect: behaviour,
    fetchLog: async () => new ReadableStream<Uint8Array>(),
  };
}

const EMPTY: CollectResult = { repos: [], runs: [], updates: [], warnings: [], complete: true };

test('a cycle already running causes the next tick to be skipped', async () => {
  const { sqlite, db } = fresh();
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const logged: string[] = [];

  const loop = new SyncLoop(db, [stub('slow', async () => { await gate; return EMPTY; })], {
    intervalMs: 1000,
    stalledAfterMs: 7 * DAY,
    log: (m) => logged.push(m),
  });

  const first = loop.runCycle();
  const second = await loop.runCycle();

  assert.equal(second.skipped, true, 'the second tick must be dropped, not queued');
  assert.ok(logged.some((m) => /still running, skipping/.test(m)));

  release();
  const done = await first;
  assert.equal(done.skipped, false);
  assert.equal(loop.busy, false);
  sqlite.close();
});

test('a failing source does not stop the others and lands in sync_status', async () => {
  const { sqlite, db } = fresh();
  const loop = new SyncLoop(
    db,
    [
      stub('broken', async () => {
        throw new Error('CE responded 503');
      }),
      stub('healthy', async () => ({
        repos: [repoOf('healthy', 'acme/widget')],
        runs: [runOf('healthy', 'acme/widget', 'j1', 'success', Date.now())],
        updates: [],
        warnings: [], complete: true,
      })),
    ],
    { intervalMs: 1000, stalledAfterMs: 7 * DAY, log: () => {} },
  );

  const report = await loop.runCycle();
  assert.deepEqual(
    report.sources.map((s) => [s.sourceAdapterId, s.outcome]),
    [['broken', 'failed'], ['healthy', 'ok']],
  );

  const rows = db.all<{ sourceAdapterId: string; outcome: string; error: string | null }>(sql`
    select source_adapter_id as sourceAdapterId, outcome, error from sync_status order by source_adapter_id
  `);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.outcome, 'failed');
  assert.match(rows[0]?.error ?? '', /503/);
  assert.equal(rows[1]?.outcome, 'ok');
  sqlite.close();
});

test('a source that fails mid-write leaves no partial rows', async () => {
  const { sqlite, db } = fresh();
  // A run naming a repository that was never collected is dropped by persist,
  // so instead break the transaction itself with a status the schema rejects.
  const bad = {
    repos: [repoOf('src', 'acme/widget')],
    runs: [{ ...runOf('src', 'acme/widget', 'j1', 'success', Date.now()), status: undefined as never }],
    updates: [],
    warnings: [], complete: true,
  } satisfies CollectResult;

  const loop = new SyncLoop(db, [stub('src', async () => bad)], {
    intervalMs: 1000,
    stalledAfterMs: 7 * DAY,
    log: () => {},
  });

  const report = await loop.runCycle();
  assert.equal(report.sources[0]?.outcome, 'failed');

  const [counts] = db.all<{ repos: number; runs: number }>(sql`
    select (select count(*) from repo) as repos, (select count(*) from renovate_run) as runs
  `);
  assert.equal(counts?.repos, 0, 'the repository write must roll back with the run write');
  assert.equal(counts?.runs, 0);
  sqlite.close();
});

test('retries back off exponentially and stop at the interval', () => {
  const interval = 300_000;
  assert.equal(backoffMs(0, interval), 0);
  assert.equal(backoffMs(1, interval), 1_000);
  assert.equal(backoffMs(2, interval), 2_000);
  assert.equal(backoffMs(3, interval), 4_000);
  assert.equal(backoffMs(10, interval), 300_000, 'capped at the sync interval');
  assert.equal(backoffMs(40, interval), 300_000, 'never overflows past the cap');
});

test('a source in backoff is not called until its wait has passed', async () => {
  const { sqlite, db } = fresh();
  let clock = 1_000_000;
  let calls = 0;

  const loop = new SyncLoop(
    db,
    [
      stub('flaky', async () => {
        calls += 1;
        throw new Error('down');
      }),
    ],
    { intervalMs: 300_000, stalledAfterMs: 7 * DAY, now: () => clock, log: () => {} },
  );

  await loop.runCycle();
  assert.equal(calls, 1);

  // Immediately after: still waiting.
  const second = await loop.runCycle();
  assert.equal(second.sources[0]?.outcome, 'backoff');
  assert.equal(calls, 1, 'the source must not be called while backing off');

  // After the first 1s wait: tried again, and the wait doubles.
  clock += 1_100;
  await loop.runCycle();
  assert.equal(calls, 2);

  clock += 1_100;
  const fourth = await loop.runCycle();
  assert.equal(fourth.sources[0]?.outcome, 'backoff', 'the second failure waits 2s, not 1s');
  assert.equal(calls, 2);
  sqlite.close();
});

test('a recovered source clears its backoff', async () => {
  const { sqlite, db } = fresh();
  let clock = 1_000_000;
  let healthy = false;

  const loop = new SyncLoop(
    db,
    [stub('src', async () => {
      if (!healthy) throw new Error('down');
      return EMPTY;
    })],
    { intervalMs: 300_000, stalledAfterMs: 7 * DAY, now: () => clock, log: () => {} },
  );

  await loop.runCycle();
  healthy = true;
  clock += 1_100;
  assert.equal((await loop.runCycle()).sources[0]?.outcome, 'ok');

  // A later failure must start from one second again, not from where it left off.
  healthy = false;
  const failed = await loop.runCycle();
  assert.equal(failed.sources[0]?.retryAt, clock + 1_000);
  sqlite.close();
});

test('stalled is set for a repository with no recent successful run, and cleared when one arrives', async () => {
  const { sqlite, db } = fresh();
  const now = Date.parse('2026-08-06T12:00:00Z');
  const old = now - 30 * DAY;

  let collect: CollectResult = {
    repos: [repoOf('src', 'acme/quiet'), repoOf('src', 'acme/busy')],
    runs: [
      runOf('src', 'acme/quiet', 'j-old', 'success', old),
      runOf('src', 'acme/busy', 'j-new', 'success', now - 1000),
    ],
    updates: [],
    warnings: [], complete: true,
  };

  const loop = new SyncLoop(db, [stub('src', async () => collect)], {
    intervalMs: 1000,
    stalledAfterMs: 7 * DAY,
    now: () => now,
    log: () => {},
  });
  await loop.runCycle();

  const read = () =>
    Object.fromEntries(
      db
        .all<{ fullName: string; stalled: number }>(sql`select full_name as fullName, stalled from repo`)
        .map((r) => [r.fullName, r.stalled]),
    );

  assert.deepEqual(read(), { 'acme/quiet': 1, 'acme/busy': 0 });

  // The quiet repository runs again. The flag must clear, not only ever be set.
  collect = {
    ...collect,
    runs: [...collect.runs, runOf('src', 'acme/quiet', 'j-fresh', 'success', now - 500)],
  };
  await loop.runCycle();
  assert.deepEqual(read(), { 'acme/quiet': 0, 'acme/busy': 0 });
  sqlite.close();
});

test('a repository whose only recent runs failed counts as stalled', async () => {
  const { sqlite, db } = fresh();
  const now = Date.parse('2026-08-06T12:00:00Z');

  const loop = new SyncLoop(
    db,
    [
      stub('src', async () => ({
        repos: [repoOf('src', 'acme/failing')],
        runs: [
          runOf('src', 'acme/failing', 'j-ok', 'success', now - 30 * DAY),
          runOf('src', 'acme/failing', 'j-bad', 'failed', now - 1000),
        ],
        updates: [],
        warnings: [], complete: true,
      })),
    ],
    { intervalMs: 1000, stalledAfterMs: 7 * DAY, now: () => now, log: () => {} },
  );

  await loop.runCycle();
  const [row] = db.all<{ stalled: number }>(sql`select stalled from repo`);
  assert.equal(row?.stalled, 1, 'failing for a month is not quietly healthy');
  sqlite.close();
});

test('warnings make a cycle partial rather than failed', async () => {
  const { sqlite, db } = fresh();
  const logged: string[] = [];
  const loop = new SyncLoop(
    db,
    [stub('src', async () => ({ ...EMPTY, warnings: ['the job family is off'] }))],
    { intervalMs: 1000, stalledAfterMs: 7 * DAY, log: (m) => logged.push(m) },
  );

  const report = await loop.runCycle();
  assert.equal(report.sources[0]?.outcome, 'partial');
  assert.ok(logged.some((m) => /the job family is off/.test(m)));
  sqlite.close();
});

test('with no retention set, no run is ever deleted', async () => {
  const { sqlite, db } = fresh();
  const old = Date.now() - 400 * DAY;
  const loop = new SyncLoop(
    db,
    [stub('keep', async () => ({
      repos: [repoOf('keep', 'acme/widget')],
      runs: [runOf('keep', 'acme/widget', 'ancient', 'success', old)],
      updates: [],
      warnings: [], complete: true,
    }))],
    { intervalMs: 1000, stalledAfterMs: 7 * DAY, log: () => {} },
  );

  const report = await loop.runCycle();
  assert.equal(report.pruned, 0);
  const n = (db.$client.prepare('select count(*) as n from renovate_run').get() as { n: number }).n;
  assert.equal(n, 1, 'a year-old run must survive when retention is unset');
  sqlite.close();
});

test('with retention set, runs the source dropped are pruned; still-listed ones are not', async () => {
  const { sqlite, db } = fresh();
  const now = Date.now();
  // The source's own retention window shrinks between cycles: first it still
  // lists the stale run, then it stops. Pruning a still-listed run would be
  // churn — the next cycle re-inserts it under a new row id — so retention
  // only takes a run once its source has let go of it.
  let listed = [
    runOf('prune', 'acme/widget', 'fresh', 'success', now - 1 * DAY),
    runOf('prune', 'acme/widget', 'stale', 'success', now - 60 * DAY),
  ];
  const loop = new SyncLoop(
    db,
    [stub('prune', async () => ({
      repos: [repoOf('prune', 'acme/widget')],
      runs: listed,
      updates: [],
      warnings: [], complete: true,
    }))],
    { intervalMs: 1000, stalledAfterMs: 7 * DAY, retentionMs: 30 * DAY, log: () => {}, now: () => now },
  );

  const first = await loop.runCycle();
  assert.equal(first.pruned, 0, 'a run the source still lists is not pruned');

  listed = listed.slice(0, 1);
  const second = await loop.runCycle();
  assert.equal(second.pruned, 1, 'a dropped run past the window is pruned');

  const jobs = db.$client
    .prepare('select external_job_id from renovate_run')
    .all()
    .map((r) => (r as { external_job_id: string }).external_job_id);
  assert.deepEqual(jobs, ['fresh'], 'only the run inside the window remains');
  sqlite.close();
});

/** Let the cycle a mocked tick started run to completion. */
async function drain(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('start runs a cycle each interval, once, and stop ends them', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { sqlite, db } = fresh();
  let cycles = 0;
  const loop = new SyncLoop(
    db,
    [stub('tick', async () => {
      cycles += 1;
      return EMPTY;
    })],
    { intervalMs: 1000, stalledAfterMs: 7 * DAY, log: () => {} },
  );

  loop.start();
  loop.start(); // a second start must not add a second timer

  t.mock.timers.tick(1000);
  await drain();
  assert.equal(cycles, 1, 'one interval, one cycle — a doubled timer would show 2');

  t.mock.timers.tick(1000);
  await drain();
  assert.equal(cycles, 2);

  loop.stop();
  t.mock.timers.tick(5000);
  await drain();
  assert.equal(cycles, 2, 'a stopped loop must not keep syncing');
  sqlite.close();
});
