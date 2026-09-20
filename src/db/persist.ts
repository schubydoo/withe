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
import { forgeRateLimit, logProblem, renovateRun, repo, source, syncStatus, update } from './schema.ts';

export interface PersistCounts {
  repos: number;
  runs: number;
  updates: number;
}

/** The forge rate-limit headroom Withe last read from the forge. */
export interface ForgeHeadroom {
  remaining: number;
  limit: number;
  resetAt: Date | null;
  /** When the forge answered with this reading, not when it was written. A cycle
   * that makes no forge request re-writes the same reading with the same
   * checkedAt, so the row does not look fresher than it is. */
  checkedAt: Date;
}

/**
 * Overwrite the one forge rate-limit row with the latest reading. Called per
 * source when a forge is configured. The row is install-wide, not per source, so
 * it has a fixed id and the last read wins.
 */
export function recordForgeStatus(db: Db, headroom: ForgeHeadroom): void {
  const set = {
    remaining: headroom.remaining,
    limit: headroom.limit,
    resetAt: headroom.resetAt,
    checkedAt: headroom.checkedAt,
  };
  db.insert(forgeRateLimit)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: forgeRateLimit.id, set })
    .run();
}

/**
 * The handle inside a transaction. Derived from `Db` rather than named from
 * drizzle's internals, so it follows the driver rather than pinning a type this
 * file would have to chase.
 */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Rewrite the problem lines of the runs whose logs this cycle read (B-4).
 *
 * Rewritten, not added to: a run's log is the whole truth about that run, so
 * its lines are replaced rather than merged. A run the cycle did not open is
 * not named in `result.problems` and keeps what it has, which is what makes a
 * failed log fetch cost nothing.
 *
 * The run must already be in the table, which it is: persist writes runs above.
 * A line naming a run this source does not have is dropped rather than
 * inserted against a guessed id.
 */
function writeProblems(tx: Tx, sourceAdapterId: string, result: CollectResult): void {
  const read = result.problems ?? [];
  if (read.length === 0) return;

  const rows = tx
    .select({ id: renovateRun.id, externalJobId: renovateRun.externalJobId })
    .from(renovateRun)
    .where(
      and(
        eq(renovateRun.sourceAdapterId, sourceAdapterId),
        inArray(
          renovateRun.externalJobId,
          read.map((entry) => entry.externalJobId),
        ),
      ),
    )
    .all();
  const runRowId = new Map(rows.map((row) => [row.externalJobId, row.id]));

  for (const entry of read) {
    const runId = runRowId.get(entry.externalJobId);
    if (runId === undefined) continue;
    tx.delete(logProblem).where(eq(logProblem.runId, runId)).run();
    for (const line of entry.problems) {
      tx.insert(logProblem)
        .values({
          sourceAdapterId,
          runId,
          level: line.level,
          message: line.message,
          at: line.at,
          occurrences: line.occurrences,
        })
        .run();
    }
  }
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
    // rather than blanking the links because one probe came back empty. That
    // sticky rule covers identity (platform, URL, cron) only. The system facts
    // describe a moment, not an identity: a cycle where the status probe
    // answered nothing must clear them — whether it answered without them
    // (meta present, system null) or did not answer at all (no meta) — rather
    // than freeze a queue depth from an hour ago and show it as current.
    const meta = result.meta;
    const system = {
      queueDepth: meta?.system?.queueDepth ?? null,
      oldestQueuedAt: meta?.system?.oldestQueuedAt ?? null,
      oldestQueuedRepo: meta?.system?.oldestQueuedRepo ?? null,
      runnerVersion: meta?.system?.runnerVersion ?? null,
      bootedAt: meta?.system?.bootedAt ?? null,
    };
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
        ...system,
      })
      .onConflictDoUpdate({
        target: source.id,
        set: {
          lastSyncAt: finishedAt,
          lastSyncOutcome: outcome,
          // A source that is being synced is configured, so a mark from an
          // earlier `reconcileSources` is stale. Re-adding a source under its
          // old id brings its history back rather than leaving it hidden.
          removedAt: null,
          ...system,
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
    //
    // Removal-by-absence needs two things: the source's repository list is the
    // full set (`authoritativeRepoList`), and this cycle read all of it
    // (`complete`). A log directory is a partial view — an absent repository
    // may simply have no log present — so it is never authoritative and its
    // repositories are never removed here.
    if (result.authoritativeRepoList && result.complete && result.repos.length > 0) {
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
    // it. Marking runs unavailable first, then setting the collected ones
    // back, computes that in two statements instead of one request per run.
    //
    // Only a complete enumeration moves the flag, and the adapter says so
    // itself (`result.complete`) rather than persist guessing from warnings —
    // a source with a permanent benign warning must not lose retention
    // forever. A complete cycle is the source's whole word: every run it did
    // not repeat — including runs of repositories it stopped listing, and the
    // all-files-deleted case where it reported nothing at all — is gone at
    // the source, and retention may take it.
    //
    // An incomplete cycle moves nothing. Scoping a partial sweep to
    // "repositories that returned runs" would still be wrong for a
    // file-backed source, where one repository's runs span files: an
    // unreadable file's runs would grey — and, with retention set, be
    // deleted — because a readable file happened to hold the same
    // repository. Silence until the next complete cycle costs only a delay
    // in greying links; guessing costs history.
    if (result.complete) {
      tx.run(sql`
        update renovate_run
           set log_available = 0
         where source_adapter_id = ${sourceAdapterId}
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
          closedAt: row.closedAt,
          closeType: row.closeType,
          detectedAt: row.detectedAt,
          packageFileCount: row.packageFileCount,
          packageFiles: row.packageFiles,
        })
        .onConflictDoNothing()
        .run();
      updates += 1;
    }

    writeProblems(tx, sourceAdapterId, result);

    // Keep the outcome (B-10). The delete above is where a finished update
    // leaves the pending view: once Renovate stops listing the branch, nothing
    // re-inserts it and the fact that it ever landed is gone. Copying here,
    // right after the current set is written, records it in the same sync that
    // detected it rather than one sync later.
    //
    // This reads the table rather than `result` so it also picks up a row in a
    // repository this cycle did not collect, and `insert or ignore` makes the
    // repeat harmless: the same finished pull request is re-read every sync
    // until its branch disappears, and `completed_natural` keeps one record.
    tx.run(sql`
      insert or ignore into completed_update (
        source_adapter_id, repo_id, dependency_name, current_version,
        target_version, update_type, datasource, package_name, final_state,
        pr_number, closed_at, archived_at
      )
      select source_adapter_id, repo_id, dependency_name, current_version,
             target_version, update_type, datasource, package_name, state,
             pr_number, closed_at, ${Math.floor(finishedAt.getTime() / 1000)}
        from \`update\`
       where source_adapter_id = ${sourceAdapterId}
         and state in ('pr-merged', 'pr-closed')
         and pr_number is not null
    `);

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
 * Mark every source that has left the configuration, and hide what it holds.
 *
 * Persist is scoped to one source and runs only for a source the worker still
 * syncs, so nothing here ever visited a source the operator deleted from the
 * configuration. Its repositories, runs, updates, completed updates and
 * problem lines stayed, and every page kept listing them. This closes that:
 * the worker calls it once a cycle with the ids it is configured to sync.
 *
 * Marked, not deleted, for the reason a removed repository is marked: the
 * source row owns runs and completed updates through foreign keys, and an
 * operator who edits a configuration file — or fixes a typo in a source id —
 * must not lose a fleet's history to it. Retention still deletes runs by age,
 * and a source re-added under the same id comes back whole (`persist` clears
 * the mark).
 *
 * The pending updates are the exception, because they are a snapshot rather
 * than history: nothing will refresh them again, so they are deleted the way
 * a removed repository's are.
 *
 * `configured` must be every source in the configuration, not the sources the
 * worker is currently able to sync: a source that is down has not left.
 *
 * Returns the ids it marked, so the worker can name them in its log.
 */
export function reconcileSources(db: Db, configured: readonly string[]): string[] {
  const now = Math.floor(Date.now() / 1000);
  return db.transaction((tx): string[] => {
    // An empty configuration reaches here only if the worker was started with
    // no source at all, which the supervisor refuses. Marking every source on
    // an empty list would be the worst possible reading of it, so it is a
    // no-op instead.
    if (configured.length === 0) return [];
    const ids = sql.join(
      configured.map((id) => sql`${id}`),
      sql`, `,
    );

    const marked = tx
      .all<{ id: string }>(sql`
        update source
           set removed_at = ${now}
         where removed_at is null
           and id not in (${ids})
        returning id
      `)
      .map((row) => row.id);
    if (marked.length === 0) return [];

    tx.run(sql`
      update repo
         set removed_at = ${now}
       where removed_at is null
         and source_adapter_id not in (${ids})
    `);
    tx.run(sql`
      delete from "update"
       where source_adapter_id not in (${ids})
    `);

    return marked;
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
      // `removedAt: null` for the reason persist clears it: a source the worker
      // is trying to sync is configured, whatever the attempt came back with.
      // Without this a source re-added with a bad token would stay hidden
      // exactly when the health page is the one thing that should name it.
      .values({ id: sourceAdapterId, kind, lastSyncOutcome: 'failed', removedAt: null })
      .onConflictDoUpdate({
        target: source.id,
        set: { lastSyncOutcome: 'failed', removedAt: null },
      })
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
 * Only `renovate_run` rows and the problem lines they own are pruned.
 * Repositories, pending updates and the forge each row points at stay: they
 * describe the present, not the past. A run whose timestamps are all null is
 * left alone rather than guessed at.
 *
 * Only runs the source no longer lists are pruned (`log_available = 0` —
 * persist flips it for exactly this fact). Pruning a run the source still
 * reports would be theatre: the next sync re-inserts it under a new row id,
 * breaking every link to the old one, and the row count never drops. For a
 * server source the still-listed window is the server's own retention; for a
 * file-backed source it is the files, which is the Task 4.5 rule — deleting
 * the file is the operator's retention statement, and this is where it takes
 * effect.
 *
 * The delete alone frees pages inside the file without shrinking it —
 * `auto_vacuum = INCREMENTAL` (set in `openDatabase` before any table exists)
 * only marks them reusable. `incremental_vacuum` moves them out, and in WAL
 * mode the main file is not truncated until a checkpoint, so both run here.
 * Without all three the file grows forever and the pragma is theatre.
 */
export function pruneOldRuns(db: Db, cutoff: Date): number {
  const seconds = Math.floor(cutoff.getTime() / 1000);
  const deleted = db.transaction((tx): number => {
    // The run's problem lines go first, in the same transaction (B-4). They
    // reference the run, foreign keys are enforced (`openDatabase`), so the
    // delete below would fail outright with them still there. One statement
    // rather than a row at a time: the two conditions are the run delete's own.
    tx.run(sql`
      delete from log_problem
       where run_id in (
         select id from renovate_run
          where coalesce(completed_at, started_at, queued_at) < ${seconds}
            and log_available = 0
       )
    `);
    return tx.run(sql`
      delete from renovate_run
       where coalesce(completed_at, started_at, queued_at) < ${seconds}
         and log_available = 0
    `).changes;
  });

  if (deleted > 0) {
    db.run(sql`PRAGMA incremental_vacuum`);
    // The truncation lands on the main file only at checkpoint. TRUNCATE also
    // caps the WAL, which a long-lived worker would otherwise let grow.
    db.$client.pragma('wal_checkpoint(TRUNCATE)');
  }

  return deleted;
}

/**
 * Delete completed updates older than `cutoff`, and give the space back.
 *
 * The archive is a third growing stream next to run metadata, so it gets the
 * same window rather than its own: one `WITHE_RETENTION_DAYS` answers for both,
 * and unset still means keep everything (PRD Section 6.3.1). The caller prunes
 * both in the same cycle.
 *
 * Age is the date the pull request closed, falling back to the date Withe
 * archived it, so a forge that reported no date still prunes instead of
 * accumulating forever.
 *
 * There is no `log_available` equivalent here, unlike `pruneOldRuns`. While
 * Renovate still lists a finished branch, persist re-reads it each sync and
 * `insert or ignore` puts a deleted record back, so such a row is pruned and
 * restored until the branch goes. That costs a cycle rather than correctness,
 * and it needs a branch to linger past the whole retention window to happen at
 * all. Age stays the only question until a fleet shows otherwise.
 *
 * The vacuum and checkpoint are needed for the same reason they are in
 * `pruneOldRuns`: without them the file never shrinks.
 */
export function pruneCompletedUpdates(db: Db, cutoff: Date): number {
  const seconds = Math.floor(cutoff.getTime() / 1000);
  const deleted = db.run(sql`
    delete from completed_update
     where coalesce(closed_at, archived_at) < ${seconds}
  `).changes;

  if (deleted > 0) {
    db.run(sql`PRAGMA incremental_vacuum`);
    db.$client.pragma('wal_checkpoint(TRUNCATE)');
  }

  return deleted;
}
