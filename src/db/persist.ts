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
import type { openDatabase } from './client.ts';
import { renovateRun, repo, source, syncStatus, update } from './schema.ts';

type Db = ReturnType<typeof openDatabase>['db'];

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

    tx.insert(source)
      .values({ id: sourceAdapterId, kind, lastSyncAt: finishedAt, lastSyncOutcome: outcome })
      .onConflictDoUpdate({
        target: source.id,
        set: { lastSyncAt: finishedAt, lastSyncOutcome: outcome },
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
        })
        .onConflictDoUpdate({
          target: [renovateRun.sourceAdapterId, renovateRun.externalJobId],
          set: {
            completedAt: row.completedAt,
            status: row.status,
            error: row.error,
            artifactErrors: row.artifactErrors,
            runnerVersion: row.runnerVersion,
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
          state: row.state,
          prUrl: row.pullRequestUrl,
          prNumber: row.pullRequestNumber,
          detectedAt: row.detectedAt,
          packageFileCount: row.packageFileCount,
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

/** Mark repositories whose newest run is older than the threshold. */
export function markStalled(db: Db, olderThan: Date): number {
  const marked = db
    .update(repo)
    .set({ stalled: true })
    .where(
      sql`${repo.id} in (
        select ${repo.id} from ${repo}
        left join ${renovateRun} on ${renovateRun.repoId} = ${repo.id}
        group by ${repo.id}
        having max(${renovateRun.completedAt}) is null
            or max(${renovateRun.completedAt}) < ${Math.floor(olderThan.getTime() / 1000)}
      )`,
    )
    .run();
  return marked.changes;
}
