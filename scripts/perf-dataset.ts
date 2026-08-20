/**
 * Synthesise a fleet, for the performance measurements in Task 3.8.
 *
 * The author's own fleet is 8 repositories; NFR-2 asks for 500. The numbers in
 * `docs/performance.md` are only as honest as this generator, so it builds a
 * shape close to a real fleet rather than the cheapest one: every repository
 * has a run history and a handful of pending updates, a tenth are failing, and
 * a few carry a lock-file refresh — the mix that makes the landing page do
 * work rather than render an empty table.
 */
import { openDatabase } from '../src/db/client.ts';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { renovateRun, repo, source, syncStatus, update } from '../src/db/schema.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const RUNS_PER_REPO = 30;
const UPDATES_PER_REPO = 6;

const UPDATE_TYPES = ['patch', 'minor', 'major', 'digest', 'security'] as const;
const DATASOURCES = ['npm', 'docker', 'github-releases', 'pypi', 'crate'] as const;

/** Deterministic pseudo-random so a rerun measures the same fleet. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function generate(dbPath: string, repoCount: number, nowMs: number): void {
  const { sqlite, db } = openDatabase(dbPath, { role: 'owner' });
  migrate(db, { migrationsFolder: './drizzle' });
  const rand = rng(repoCount);

  db.insert(source)
    .values({
      id: 'default',
      kind: 'ce',
      lastSyncAt: new Date(nowMs - 60_000),
      lastSyncOutcome: 'ok',
      platform: 'github',
      webBaseUrl: 'https://github.com',
    })
    .run();

  db.insert(syncStatus)
    .values({
      sourceAdapterId: 'default',
      startedAt: new Date(nowMs - 61_000),
      finishedAt: new Date(nowMs - 60_000),
      outcome: 'ok',
      repoCount,
      runCount: repoCount * RUNS_PER_REPO,
    })
    .run();

  for (let i = 0; i < repoCount; i += 1) {
    const org = `org${i % 12}`;
    const name = `service-${String(i).padStart(4, '0')}`;
    const failing = i % 10 === 0;

    db.insert(repo)
      .values({
        id: i + 1,
        sourceAdapterId: 'default',
        org,
        name,
        fullName: `${org}/${name}`,
        enabled: true,
        installStatus: 'activated',
        queueName: 'main',
        stalled: failing,
      })
      .run();

    const runs = Array.from({ length: RUNS_PER_REPO }, (_unused, r) => ({
      sourceAdapterId: 'default',
      repoId: i + 1,
      externalJobId: `job-${i}-${r}`,
      reason: 'schedule-all',
      queuedAt: new Date(nowMs - r * HOUR_MS),
      startedAt: new Date(nowMs - r * HOUR_MS),
      completedAt: new Date(nowMs - r * HOUR_MS),
      // A failing repo's newest run failed; its history succeeded.
      status: (failing && r === 0 ? 'failed' : 'success') as 'failed' | 'success',
      error: failing && r === 0 ? 'a dependency failed to resolve against the registry' : null,
      runnerVersion: '43.280.0',
      logLocation: `jobs/job-${i}-${r}`,
    }));
    db.insert(renovateRun).values(runs).run();

    const updates = Array.from({ length: UPDATES_PER_REPO }, (_unused, u) => {
      const isLock = u === UPDATES_PER_REPO - 1;
      const fileCount = isLock ? Math.floor(rand() * 8) + 1 : 1;
      return {
        sourceAdapterId: 'default',
        repoId: i + 1,
        dependencyName: isLock ? 'lock file maintenance' : `@scope/pkg-${u}`,
        currentVersion: isLock ? null : `1.${u}.0`,
        targetVersion: isLock ? null : `1.${u}.1`,
        updateType: (isLock ? 'lock-file-maintenance' : UPDATE_TYPES[u % UPDATE_TYPES.length]) as
          (typeof UPDATE_TYPES)[number] | 'lock-file-maintenance',
        datasource: isLock ? null : DATASOURCES[u % DATASOURCES.length],
        packageName: isLock ? null : `@scope/pkg-${u}`,
        state: 'detected' as const,
        prNumber: rand() > 0.5 ? Math.floor(rand() * 9000) + 1 : null,
        packageFileCount: fileCount,
        packageFiles: isLock
          ? Array.from({ length: fileCount }, (_f, k) => `crates/crate-${k}/Cargo.toml`)
          : [`packages/pkg-${u}/package.json`],
        detectedAt: new Date(nowMs - Math.floor(rand() * 5) * DAY_MS),
      };
    });
    db.insert(update).values(updates).run();
  }

  db.$client.pragma('wal_checkpoint(TRUNCATE)');
  sqlite.close();
}

// CLI: perf-dataset.ts <count> <dbPath> <nowMs>
if (process.argv[1]?.endsWith('perf-dataset.ts')) {
  const count = Number(process.argv[2]);
  const path = process.argv[3];
  const now = Number(process.argv[4] ?? '');
  if (!Number.isInteger(count) || !path || !Number.isFinite(now)) {
    console.error('usage: perf-dataset.ts <repoCount> <dbPath> <nowMs>');
    process.exit(2);
  }
  generate(path, count, now);
  console.log(`generated ${count} repositories into ${path}`);
}
