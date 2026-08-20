/**
 * Write what an adapter collected.
 *
 * Adapters return the model and never touch the database; this is the one
 * place that turns the model into rows. The internal model addresses a
 * repository by a string the adapter chose, and the database by an
 * autoincrementing integer, so resolving between the two happens here and
 * nowhere else.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { CollectResult } from '../adapters/types.ts';
import type { Db } from './client.ts';
import { renovateRun, repo, source, syncStatus, update } from './schema.ts';

export interface PersistCounts {
  repos: number;
  runs: number;
  updates: number;
}

export function persist(
  db: Db,
  sourceAdapterId: string,
  kind: 'ce' | 'jsonlog' | 'forge',
  result: CollectResult,
  startedAt: Date,
): PersistCounts {
  return db.transaction((tx): PersistCounts => {
    const finishedAt = new Date();
    const outcome = result.warnings.length > 0 ? 'partial' : 'ok';

    // A source that could not report its forge keeps whatever it last said,
    // rather than blanking the links because one probe came back empty.
    const meta = result.meta;
    tx.insert(source)
      .values({
        id: sourceAdapterId,
        kind,
        lastSyncAt: finishedAt,
        lastSyncOutcome: outcome,
        platform: meta?.platform ?? null,
        webBaseUrl: meta?.webBaseUrl ?? null,
        scheduleCron: meta?.scheduleCron ?? null,
        scheduleLastAt: meta?.scheduleLastAt ?? null,
      })
      .onConflictDoUpdate({
        target: source.id,
        set: {
          lastSyncAt: finishedAt,
          lastSyncOutcome: outcome,
          ...(meta
            ? {
                platform: meta.platform,
                webBaseUrl: meta.webBaseUrl,
                scheduleCron: meta.scheduleCron,
                scheduleLastAt: meta.scheduleLastAt,
              }
            : {}),
        },
      })
      .run();

    for (const row of result.repos) {
      tx.insert(repo)
        .values({
          sourceAdapterId,
          org: row.org,
          name: row.name,
          fullName: row.fullName,
          enabled: row.enabled,
          installStatus: row.installStatus,
          queueName: row.queueName,
          installedAt: row.installedAt,
          removedAt: row.removedAt,
        })
        .onConflictDoUpdate({
          target: [repo.sourceAdapterId, repo.fullName],
          set: {
            enabled: row.enabled,
            installStatus: row.installStatus,
            queueName: row.queueName,
            removedAt: row.removedAt,
          },
        })
        .run();
    }

    // A repository the source no longer lists has been uninstalled or made
    // private. Deleting the row would take its run history with it and make the
    // repository look like it never existed; marking it removed keeps the
    // record and lets the inventory say what happened.
    if (result.repos.length > 0) {
      const present = result.repos.map((r) => r.fullName);
      tx.run(sql`
        update repo
           set removed_at = ${Math.floor(finishedAt.getTime() / 1000)}
         where source_adapter_id = ${sourceAdapterId}
           and removed_at is null
           and full_name not in (${sql.join(present.map((n) => sql`${n}`), sql`, `)})
      `);
      // Their pending updates go with them: the snapshot delete further down
      // only covers repositories the source still lists. Matching every
      // removed repository, not only the newly marked, also clears rows that
      // databases from before this delete still hold.
      tx.run(sql`
        delete from "update"
         where source_adapter_id = ${sourceAdapterId}
           and repo_id in (select id from repo
                            where source_adapter_id = ${sourceAdapterId}
                              and removed_at is not null)
      `);
    }

    // One read, then an in-memory map. Resolving each run's repository with its
    // own query would be one statement per row.
    const rowIds = new Map<string, number>();
    for (const row of tx
      .select({ id: repo.id, fullName: repo.fullName })
      .from(repo)
      .where(eq(repo.sourceAdapterId, sourceAdapterId))
      .all()) {
      rowIds.set(row.fullName, row.id);
    }

    const idFor = (modelRepoId: string): number | undefined => {
      // The adapter's repository id is `<source>:<org>/<name>`.
      const fullName = modelRepoId.slice(modelRepoId.indexOf(':') + 1);
      return rowIds.get(fullName);
    };

    // A run the source no longer lists has been purged there, and its log with
    // it. Marking every touched repository's runs unavailable first, then
    // setting the collected ones back, computes that in two statements instead
    // of one request per run.
    const repoIds = [...rowIds.values()];
    if (repoIds.length > 0 && result.runs.length > 0) {
      tx.run(sql`
        update renovate_run
           set log_available = 0
         where source_adapter_id = ${sourceAdapterId}
           and repo_id in (${sql.join(repoIds.map((n) => sql`${n}`), sql`, `)})
      `);
    }

    let runs = 0;
    for (const row of result.runs) {
      const repoRowId = idFor(row.repoId);
      if (repoRowId === undefined) continue;
      tx.insert(renovateRun)
        .values({
          sourceAdapterId,
          repoId: repoRowId,
          externalJobId: row.externalJobId,
          reason: row.triggerReason,
          queuedAt: row.queuedAt,
          startedAt: row.startedAt,
          completedAt: row.completedAt,
          status: row.status,
          error: row.error,
          artifactErrors: row.artifactErrors,
          logLocation: row.logLocation,
          runnerVersion: row.runnerVersion,
          logAvailable: true,
        })
        .onConflictDoUpdate({
          target: [renovateRun.sourceAdapterId, renovateRun.externalJobId],
          set: {
            completedAt: row.completedAt,
            status: row.status,
            error: row.error,
            artifactErrors: row.artifactErrors,
            runnerVersion: row.runnerVersion,
            logAvailable: true,
          },
        })
        .run();
      runs += 1;
    }

    // Pending updates are a snapshot, not a history. An update that was merged
    // since the last sync must disappear, so the repositories just collected
    // are cleared before their current set is written.
    const touched = [...new Set(result.repos.map((r) => rowIds.get(r.fullName)))].filter(
      (id): id is number => id !== undefined,
    );
    if (touched.length > 0) {
      tx.delete(update)
        .where(and(eq(update.sourceAdapterId, sourceAdapterId), inArray(update.repoId, touched)))
        .run();
    }

    let updates = 0;
    for (const row of result.updates) {
      const repoRowId = idFor(row.repoId);
      if (repoRowId === undefined) continue;
      tx.insert(update)
        .values({
          sourceAdapterId,
          repoId: repoRowId,
          dependencyName: row.dependencyName,
          currentVersion: row.currentVersion,
          targetVersion: row.targetVersion,
          updateType: row.updateType,
          datasource: row.datasource,
          packageName: row.packageName,
          state: row.state,
          prUrl: row.pullRequestUrl,
          prNumber: row.pullRequestNumber,
          detectedAt: row.detectedAt,
          packageFileCount: row.packageFileCount,
          packageFiles: row.packageFiles,
        })
        .onConflictDoNothing()
        .run();
      updates += 1;
    }

    tx.insert(syncStatus)
      .values({
        sourceAdapterId,
        startedAt,
        finishedAt,
        outcome,
        error: result.warnings.length > 0 ? result.warnings.join('\n') : null,
        repoCount: result.repos.length,
        runCount: result.runs.length,
      })
      .run();

    return { repos: result.repos.length, runs, updates };
  });
}

/**
 * Recompute the stalled flag for every repository of one source.
 *
 * Stalled means no **successful** run since the cutoff. A repository that has
 * been failing for a week is not quietly healthy, and one that recovers must
 * clear the flag, so this sets both true and false rather than only marking.
 */
export function recomputeStalled(db: Db, sourceAdapterId: string, cutoff: Date): number {
  const seconds = Math.floor(cutoff.getTime() / 1000);
  const result = db.run(sql`
    update repo
       set stalled = not exists (
             select 1 from renovate_run rr
              where rr.repo_id = repo.id
                and rr.status = 'success'
                and rr.completed_at >= ${seconds}
           )
     where repo.source_adapter_id = ${sourceAdapterId}
  `);
  return result.changes;
}

/** Record a source that failed before it produced anything to persist. */
export function recordSyncFailure(
  db: Db,
  sourceAdapterId: string,
  kind: 'ce' | 'jsonlog' | 'forge',
  startedAt: Date,
  error: string,
): void {
  db.transaction((tx) => {
    tx.insert(source)
      .values({ id: sourceAdapterId, kind, lastSyncOutcome: 'failed' })
      .onConflictDoUpdate({ target: source.id, set: { lastSyncOutcome: 'failed' } })
      .run();
    tx.insert(syncStatus)
      .values({
        sourceAdapterId,
        startedAt,
        finishedAt: new Date(),
        outcome: 'failed',
        error,
        repoCount: null,
        runCount: null,
      })
      .run();
  });
}

/**
 * Delete run metadata older than `cutoff`, and give the space back to the disk.
 *
 * Only `renovate_run` rows are pruned. Repositories, pending updates and the
 * forge each row points at stay: they describe the present, not the past. A
 * run whose timestamps are all null is left alone rather than guessed at.
 *
 * The delete alone frees pages inside the file without shrinking it —
 * `auto_vacuum = INCREMENTAL` (set in `openDatabase` before any table exists)
 * only marks them reusable. `incremental_vacuum` moves them out, and in WAL
 * mode the main file is not truncated until a checkpoint, so both run here.
 * Without all three the file grows forever and the pragma is theatre.
 */
export function pruneOldRuns(db: Db, cutoff: Date): number {
  const seconds = Math.floor(cutoff.getTime() / 1000);
  const deleted = db.run(sql`
    delete from renovate_run
     where coalesce(completed_at, started_at, queued_at) < ${seconds}
  `).changes;

  if (deleted > 0) {
    db.run(sql`PRAGMA incremental_vacuum`);
    // The truncation lands on the main file only at checkpoint. TRUNCATE also
    // caps the WAL, which a long-lived worker would otherwise let grow.
    db.$client.pragma('wal_checkpoint(TRUNCATE)');
  }

  return deleted;
}
