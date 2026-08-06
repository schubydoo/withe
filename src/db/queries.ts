/**
 * What the pages read. Every function here is one statement.
 *
 * The page never calls a source. It reads rows the worker wrote, so a slow or
 * unreachable server makes the dashboard stale rather than broken.
 */
import { sql } from 'drizzle-orm';

import type { UpdateType } from '../core/model.ts';
import type { openDatabase } from './client.ts';

type Db = ReturnType<typeof openDatabase>['db'];

export interface PendingUpdateRow {
  repoFullName: string;
  dependencyName: string;
  currentVersion: string | null;
  targetVersion: string | null;
  updateType: UpdateType;
  prNumber: number | null;
  packageFileCount: number;
}

export interface RepoHealthRow {
  fullName: string;
  status: string | null;
  completedAt: Date | null;
  pendingCount: number;
}

/**
 * Every pending update, newest repository first.
 *
 * Lock-file refreshes are excluded here and counted separately. They were 20 of
 * 26 on the author's install and would bury everything that names a dependency.
 */
export function pendingUpdates(db: Db): PendingUpdateRow[] {
  return db.all<PendingUpdateRow>(sql`
    select r.full_name        as repoFullName,
           u.dependency_name  as dependencyName,
           u.current_version  as currentVersion,
           u.target_version   as targetVersion,
           u.update_type      as updateType,
           u.pr_number        as prNumber,
           u.package_file_count as packageFileCount
      from "update" u
      join repo r on r.id = u.repo_id
     where u.update_type is not 'lock-file-maintenance'
     order by r.full_name, u.dependency_name
  `);
}

/** How many lock-file refreshes are pending, and in how many repositories. */
export function lockFileRefreshes(db: Db): { total: number; repos: number } {
  const [row] = db.all<{ total: number; repos: number }>(sql`
    select count(*) as total, count(distinct repo_id) as repos
      from "update"
     where update_type is 'lock-file-maintenance'
  `);
  return row ?? { total: 0, repos: 0 };
}

/**
 * One row per repository with its newest run and its pending count.
 *
 * One statement, not one per repository. The correlated subqueries below both
 * use indexes the schema already declares.
 */
export function repoHealth(db: Db): RepoHealthRow[] {
  const rows = db.all<{
    fullName: string;
    status: string | null;
    completedAt: number | null;
    pendingCount: number;
  }>(sql`
    select r.full_name as fullName,
           (select rr.status from renovate_run rr
             where rr.repo_id = r.id
             order by rr.completed_at desc limit 1) as status,
           (select rr.completed_at from renovate_run rr
             where rr.repo_id = r.id
             order by rr.completed_at desc limit 1) as completedAt,
           (select count(*) from "update" u where u.repo_id = r.id) as pendingCount
      from repo r
     where r.removed_at is null
     order by r.full_name
  `);

  return rows.map((row) => ({
    fullName: row.fullName,
    status: row.status,
    completedAt: row.completedAt === null ? null : new Date(row.completedAt * 1000),
    pendingCount: row.pendingCount,
  }));
}

export interface SyncSummary {
  lastSyncAt: Date | null;
  outcome: string | null;
}

export function lastSync(db: Db): SyncSummary {
  const [row] = db.all<{ lastSyncAt: number | null; outcome: string | null }>(sql`
    select last_sync_at as lastSyncAt, last_sync_outcome as outcome
      from source order by last_sync_at desc limit 1
  `);
  return {
    lastSyncAt: row?.lastSyncAt ? new Date(row.lastSyncAt * 1000) : null,
    outcome: row?.outcome ?? null,
  };
}

export interface InventoryRow {
  sourceAdapterId: string;
  org: string;
  name: string;
  fullName: string;
  enabled: boolean;
  installStatus: string | null;
  queueName: string | null;
  removedAt: Date | null;
  stalled: boolean;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  pendingCount: number;
}

/**
 * Every repository, including ones the source has stopped listing.
 *
 * Removed repositories stay visible. Dropping them would take their run history
 * with them and make a repository that was uninstalled look like one that never
 * existed, which is a worse answer to "where did it go".
 */
export function repoInventory(db: Db): InventoryRow[] {
  const rows = db.all<{
    sourceAdapterId: string;
    org: string;
    name: string;
    fullName: string;
    enabled: number;
    installStatus: string | null;
    queueName: string | null;
    removedAt: number | null;
    stalled: number;
    lastRunAt: number | null;
    lastRunStatus: string | null;
    pendingCount: number;
  }>(sql`
    select r.source_adapter_id as sourceAdapterId,
           r.org, r.name, r.full_name as fullName,
           r.enabled, r.install_status as installStatus,
           r.queue_name as queueName, r.removed_at as removedAt, r.stalled,
           (select rr.completed_at from renovate_run rr
             where rr.repo_id = r.id order by rr.completed_at desc limit 1) as lastRunAt,
           (select rr.status from renovate_run rr
             where rr.repo_id = r.id order by rr.completed_at desc limit 1) as lastRunStatus,
           (select count(*) from "update" u where u.repo_id = r.id) as pendingCount
      from repo r
     order by r.org, r.name
  `);

  return rows.map((row) => ({
    ...row,
    enabled: row.enabled === 1,
    stalled: row.stalled === 1,
    removedAt: row.removedAt === null ? null : new Date(row.removedAt * 1000),
    lastRunAt: row.lastRunAt === null ? null : new Date(row.lastRunAt * 1000),
  }));
}

export interface RunRow {
  /** Database id, used to address the log without exposing upstream paths. */
  id: number;
  externalJobId: string;
  reason: string | null;
  queuedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  status: string;
  error: string | null;
  artifactErrors: string[];
  runnerVersion: string | null;
  /** False once the source has purged the run, and its log with it. */
  logAvailable: boolean;
}

export const RUNS_PER_PAGE = 200;

/**
 * One repository's runs, newest first.
 *
 * Paginated because a repository accumulates roughly 190 runs per retention
 * window at the source, and more once Withe keeps its own history: run metadata
 * is kept indefinitely by default (PRD Section 6.3.1), so this list only grows.
 */
export function runsForRepo(
  db: Db,
  fullName: string,
  page = 0,
  perPage = RUNS_PER_PAGE,
): { runs: RunRow[]; total: number } {
  const [count] = db.all<{ total: number }>(sql`
    select count(*) as total
      from renovate_run rr join repo r on r.id = rr.repo_id
     where r.full_name = ${fullName}
  `);

  const rows = db.all<{
    id: number;
    externalJobId: string;
    reason: string | null;
    queuedAt: number | null;
    startedAt: number | null;
    completedAt: number | null;
    status: string;
    error: string | null;
    artifactErrors: string | null;
    runnerVersion: string | null;
    logAvailable: number;
  }>(sql`
    select rr.id, rr.external_job_id as externalJobId, rr.reason,
           rr.queued_at as queuedAt, rr.started_at as startedAt,
           rr.completed_at as completedAt, rr.status, rr.error,
           rr.artifact_errors as artifactErrors, rr.runner_version as runnerVersion,
           rr.log_available as logAvailable
      from renovate_run rr join repo r on r.id = rr.repo_id
     where r.full_name = ${fullName}
     order by coalesce(rr.completed_at, rr.started_at, rr.queued_at) desc, rr.id desc
     limit ${perPage} offset ${page * perPage}
  `);

  return {
    total: count?.total ?? 0,
    runs: rows.map((row) => ({
      id: row.id,
      externalJobId: row.externalJobId,
      reason: row.reason,
      queuedAt: seconds(row.queuedAt),
      startedAt: seconds(row.startedAt),
      completedAt: seconds(row.completedAt),
      status: row.status,
      error: row.error,
      // Stored as a JSON column. A malformed value must not take the page down
      // with it, so it degrades to no entries.
      artifactErrors: parseList(row.artifactErrors),
      runnerVersion: row.runnerVersion,
      logAvailable: row.logAvailable === 1,
    })),
  };
}

function seconds(value: number | null): Date | null {
  return value === null ? null : new Date(value * 1000);
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export interface RunLocation {
  sourceAdapterId: string;
  repoFullName: string;
  externalJobId: string;
}

/**
 * Where a run's log lives, resolved from a row rather than from the URL.
 *
 * The log route takes a database id and looks the rest up here. Nothing the
 * browser sends reaches the upstream path, so a crafted id cannot address an
 * endpoint Withe was never meant to call.
 */
export function runLocation(db: Db, id: number): RunLocation | null {
  const [row] = db.all<RunLocation>(sql`
    select rr.source_adapter_id as sourceAdapterId,
           r.full_name as repoFullName,
           rr.external_job_id as externalJobId
      from renovate_run rr join repo r on r.id = rr.repo_id
     where rr.id = ${id}
     limit 1
  `);
  return row ?? null;
}
