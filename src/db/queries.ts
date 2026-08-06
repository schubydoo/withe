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
