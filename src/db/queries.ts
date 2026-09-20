/**
 * What the pages read. Every function here is one statement.
 *
 * The page never calls a source. It reads rows the worker wrote, so a slow or
 * unreachable server makes the dashboard stale rather than broken.
 */
import { sql } from 'drizzle-orm';

import { reportsSystemFacts, type SourceKind } from '../adapters/types.ts';
import type { UpdateType } from '../core/model.ts';
import type { ProblemLevel } from '../core/renovate-log.ts';
import type { Db } from './client.ts';

export interface PendingUpdateRow {
  sourceAdapterId: string;
  repoFullName: string;
  dependencyName: string;
  currentVersion: string | null;
  targetVersion: string | null;
  updateType: UpdateType;
  datasource: string | null;
  packageName: string | null;
  prNumber: number | null;
  packageFileCount: number;
}

export interface LockFileRefreshRow {
  sourceAdapterId: string;
  repoFullName: string;
  /** The Renovate branch. One branch is one refresh, whatever it covers. */
  branchName: string;
  /** How many manifests the branch refreshes. A Cargo workspace has many. */
  packageFileCount: number;
  /** Those manifests by path. Empty on rows written before the column existed. */
  packageFiles: string[];
  prNumber: number | null;
}

export interface CompletedUpdateRow {
  sourceAdapterId: string;
  repoFullName: string;
  dependencyName: string;
  currentVersion: string | null;
  targetVersion: string | null;
  updateType: UpdateType;
  datasource: string | null;
  packageName: string | null;
  /** Merged, or closed without merging. Two different facts, never inferred. */
  finalState: 'pr-merged' | 'pr-closed';
  prNumber: number;
  /**
   * When it reached that state. Never null: the query falls back to the
   * archive date, which the schema declares NOT NULL, so there is always one.
   */
  closedAt: Date;
}

export interface LogProblemRow {
  /** The run row, which is also the address of its log page. */
  runId: number;
  repoFullName: string;
  sourceAdapterId: string;
  level: ProblemLevel;
  message: string;
  /** How many times that run wrote this same line. */
  occurrences: number;
  /**
   * When the line was written, or when its run finished if the line carried no
   * time of its own. Null only when the run carries no completion either.
   */
  at: Date | null;
}

/** How much of the fleet's problem index there is, for the search page to state. */
export interface ProblemIndexSize {
  lines: number;
  runs: number;
}

export interface RepoHealthRow {
  fullName: string;
  status: string | null;
  completedAt: Date | null;
  pendingCount: number;
}

/**
 * Every pending update, by repository name.
 *
 * Lock-file refreshes are excluded here and counted separately. They were 7 of
 * 9 on the author's install and would bury everything that names a dependency.
 */
export function pendingUpdates(db: Db): PendingUpdateRow[] {
  return db.all<PendingUpdateRow>(sql`
    select u.source_adapter_id as sourceAdapterId,
           r.full_name        as repoFullName,
           u.dependency_name  as dependencyName,
           u.current_version  as currentVersion,
           u.target_version   as targetVersion,
           u.update_type      as updateType,
           u.datasource,
           u.package_name     as packageName,
           u.pr_number        as prNumber,
           u.package_file_count as packageFileCount
      from "update" u
      join repo r on r.id = u.repo_id
     where u.update_type is not 'lock-file-maintenance'
       and u.state is not 'pr-merged' and u.state is not 'pr-closed'
       and r.removed_at is null
     order by r.full_name, u.dependency_name
  `);
}

/**
 * Every pending lock-file refresh, one row per branch.
 *
 * These are listed apart from the named updates rather than mixed in. A
 * refresh has no dependency and no version pair, so it would fill three of the
 * five columns of the other groups with nothing.
 */
export function lockFileRefreshes(db: Db): LockFileRefreshRow[] {
  const rows = db.all<Omit<LockFileRefreshRow, 'packageFiles'> & { packageFiles: string | null }>(sql`
    select u.source_adapter_id   as sourceAdapterId,
           r.full_name           as repoFullName,
           u.dependency_name     as branchName,
           u.package_file_count  as packageFileCount,
           u.package_files       as packageFiles,
           u.pr_number           as prNumber
      from "update" u
      join repo r on r.id = u.repo_id
     where u.update_type is 'lock-file-maintenance'
       and u.state is not 'pr-merged' and u.state is not 'pr-closed'
       and r.removed_at is null
     order by r.full_name, u.dependency_name
  `);
  // Stored as a JSON column. A malformed value must not take the page down
  // with it, so it degrades to no paths.
  return rows.map((row) => ({ ...row, packageFiles: parseList(row.packageFiles) }));
}

/**
 * Updates Renovate finished with, newest first (B-10).
 *
 * The pending views answer "what is queued"; this one answers "what has
 * Renovate actually landed here, and when". It reads `completed_update`, which
 * persist writes as each outcome is detected, so it is not affected by the
 * snapshot wipe that clears the pending rows.
 *
 * A removed repository is excluded, as it is in every other query here. Its
 * history is still true, but Withe hides a repository the source stopped
 * listing everywhere else, and one page disagreeing would read as a bug.
 *
 * `limit` caps the fleet page. With retention unset the archive grows for as
 * long as the install runs, and a page is not the place to render all of it.
 */
export function completedUpdates(db: Db, limit = 250, repoFullName?: string): CompletedUpdateRow[] {
  const rows = db.all<Omit<CompletedUpdateRow, 'closedAt'> & { closedAt: number }>(sql`
    select c.source_adapter_id as sourceAdapterId,
           r.full_name         as repoFullName,
           c.dependency_name   as dependencyName,
           c.current_version   as currentVersion,
           c.target_version    as targetVersion,
           c.update_type       as updateType,
           c.datasource,
           c.package_name      as packageName,
           c.final_state       as finalState,
           c.pr_number         as prNumber,
           coalesce(c.closed_at, c.archived_at) as closedAt
      from completed_update c
      join repo r on r.id = c.repo_id
     where r.removed_at is null
       and (${repoFullName ?? null} is null or r.full_name = ${repoFullName ?? null})
     order by closedAt desc, r.full_name, c.dependency_name
     limit ${limit}
  `);

  return rows.map((row) => ({ ...row, closedAt: new Date(row.closedAt * 1000) }));
}

/**
 * Escape a search term so it matches itself (B-4).
 *
 * `%` and `_` are LIKE's own wildcards, so a person searching for `100%` would
 * otherwise match every line. The backslash is escaped first, because it is
 * what the escape clause uses and escaping it last would double the others.
 */
function likeTerm(query: string): string {
  return `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

/**
 * Every level at or worse than one level, worst first.
 *
 * The filter means "this and worse": an operator looking for errors wants the
 * fatals too, and a fatal is never something they asked to hide. Written as
 * the set rather than as a comparison so the query stays an `in` over the
 * indexed column.
 */
const AT_LEAST: Record<ProblemLevel, readonly ProblemLevel[]> = {
  warn: ['fatal', 'error', 'warn'],
  error: ['fatal', 'error'],
  fatal: ['fatal'],
};

/**
 * Search the fleet's stored problem lines (B-4).
 *
 * The level filter means that level and worse, so "error" also lists fatals.
 *
 * This searches the warn-level and worse lines Withe kept at ingest, not whole
 * logs: logs are never stored (PRD Section 6.3.1), so there is nothing else to
 * search. The page says so, because an empty result here means "no problem
 * line matched", not "nothing anywhere matched".
 *
 * An empty query lists the most recent lines, which is the useful landing
 * state: the operator most often wants to know what is wrong right now.
 *
 * A removed repository is excluded, as it is in every other query here.
 */
export function searchProblems(
  db: Db,
  options: { query?: string; level?: ProblemLevel; limit?: number } = {},
): LogProblemRow[] {
  const query = options.query?.trim() ?? '';
  const term = query === '' ? null : likeTerm(query);
  const level = options.level ?? null;
  const levels =
    level === null
      ? sql`1 = 1`
      : sql`p.level in (${sql.join(
          AT_LEAST[level].map((name) => sql`${name}`),
          sql`, `,
        )})`;
  const rows = db.all<Omit<LogProblemRow, 'at'> & { at: number | null }>(sql`
    select p.run_id            as runId,
           r.full_name         as repoFullName,
           p.source_adapter_id as sourceAdapterId,
           p.level,
           p.message,
           p.occurrences,
           coalesce(p.at, rr.completed_at, rr.started_at) as at
      from log_problem p
      join renovate_run rr on rr.id = p.run_id
      join repo r on r.id = rr.repo_id
     where r.removed_at is null
       and ${levels}
       and (${term} is null or p.message like ${term} escape '\\')
     order by at desc, p.id desc
     limit ${options.limit ?? 200}
  `);

  return rows.map((row) => ({ ...row, at: row.at === null ? null : new Date(row.at * 1000) }));
}

/**
 * How many problem lines Withe holds, and how many runs they came from.
 *
 * The search page states this. Withe indexes the log it reads at each sync,
 * which is each repository's newest finished run, so the index covers the runs
 * Withe watched rather than every run in the history. Saying how much there is
 * keeps an empty result honest.
 */
export function problemIndexSize(db: Db): ProblemIndexSize {
  const row = db.get<{ lines: number | null; runs: number | null }>(sql`
    select count(*)            as lines,
           count(distinct p.run_id) as runs
      from log_problem p
      join renovate_run rr on rr.id = p.run_id
      join repo r on r.id = rr.repo_id
     where r.removed_at is null
  `);
  return { lines: row?.lines ?? 0, runs: row?.runs ?? 0 };
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
           (select count(*) from "update" u where u.repo_id = r.id
              and u.state is not 'pr-merged' and u.state is not 'pr-closed') as pendingCount
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
           (select count(*) from "update" u where u.repo_id = r.id
              and u.state is not 'pr-merged' and u.state is not 'pr-closed') as pendingCount
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
  /** Which configured source contributed the run (Task 4.4). */
  sourceAdapterId: string;
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
  /** Restrict to one source's runs. Null merges every contributor (Task 4.4). */
  source: string | null = null,
): { runs: RunRow[]; total: number } {
  // `x is null or y = x` folds the filter into one statement. The parameter
  // is bound, so both halves are evaluated per row — cheap at this scale, and
  // one statement beats two near-identical ones drifting apart.
  const [count] = db.all<{ total: number }>(sql`
    select count(*) as total
      from renovate_run rr join repo r on r.id = rr.repo_id
     where r.full_name = ${fullName}
       and (${source} is null or rr.source_adapter_id = ${source})
  `);

  const rows = db.all<{
    id: number;
    sourceAdapterId: string;
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
    select rr.id, rr.source_adapter_id as sourceAdapterId,
           rr.external_job_id as externalJobId, rr.reason,
           rr.queued_at as queuedAt, rr.started_at as startedAt,
           rr.completed_at as completedAt, rr.status, rr.error,
           rr.artifact_errors as artifactErrors, rr.runner_version as runnerVersion,
           rr.log_available as logAvailable
      from renovate_run rr join repo r on r.id = rr.repo_id
     where r.full_name = ${fullName}
       and (${source} is null or rr.source_adapter_id = ${source})
     order by coalesce(rr.completed_at, rr.started_at, rr.queued_at) desc, rr.id desc
     limit ${perPage} offset ${page * perPage}
  `);

  return {
    total: count?.total ?? 0,
    runs: rows.map((row) => ({
      id: row.id,
      sourceAdapterId: row.sourceAdapterId,
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
  /** The run's instant — completion, else start, else queueing — for naming a
   * downloaded log. Null when the run carries none of the three. */
  at: Date | null;
}

/**
 * Where a run's log lives, resolved from a row rather than from the URL.
 *
 * The log route takes a database id and looks the rest up here. Nothing the
 * browser sends reaches the upstream path, so a crafted id cannot address an
 * endpoint Withe was never meant to call.
 */
export function runLocation(db: Db, id: number): RunLocation | null {
  const [row] = db.all<{
    sourceAdapterId: string;
    repoFullName: string;
    externalJobId: string;
    at: number | null;
  }>(sql`
    select rr.source_adapter_id as sourceAdapterId,
           r.full_name as repoFullName,
           rr.external_job_id as externalJobId,
           coalesce(rr.completed_at, rr.started_at, rr.queued_at) as at
      from renovate_run rr join repo r on r.id = rr.repo_id
     where rr.id = ${id}
     limit 1
  `);
  if (!row) return null;
  return {
    sourceAdapterId: row.sourceAdapterId,
    repoFullName: row.repoFullName,
    externalJobId: row.externalJobId,
    at: seconds(row.at),
  };
}

export interface TriageRow {
  /** Which source contributed this row, so a repo two sources watch groups to
   * one entry at display time rather than listing twice (Q-7, Task 4.8). */
  sourceAdapterId: string;
  fullName: string;
  org: string;
  name: string;
  stalled: boolean;
  lastRunStatus: string | null;
  lastRunAt: Date | null;
  lastError: string | null;
  /** When the trouble started: the newest run after the last successful one. */
  failingSince: Date | null;
  pendingCount: number;
}

/**
 * Repositories that need attention, worst first.
 *
 * `failingSince` is the age F-04 asks for. It is the oldest failure in the
 * current run of failures, not the newest one — a repository that broke a week
 * ago and has failed hourly since has been broken for a week, not an hour.
 */
export function triage(db: Db): TriageRow[] {
  const rows = db.all<{
    sourceAdapterId: string;
    fullName: string;
    org: string;
    name: string;
    stalled: number;
    lastRunStatus: string | null;
    lastRunAt: number | null;
    lastError: string | null;
    lastSuccessAt: number | null;
    pendingCount: number;
  }>(sql`
    select r.source_adapter_id as sourceAdapterId, r.full_name as fullName, r.org, r.name, r.stalled,
           (select rr.status from renovate_run rr
             where rr.repo_id = r.id order by rr.completed_at desc limit 1) as lastRunStatus,
           (select rr.completed_at from renovate_run rr
             where rr.repo_id = r.id order by rr.completed_at desc limit 1) as lastRunAt,
           (select rr.error from renovate_run rr
             where rr.repo_id = r.id order by rr.completed_at desc limit 1) as lastError,
           (select max(rr.completed_at) from renovate_run rr
             where rr.repo_id = r.id and rr.status = 'success') as lastSuccessAt,
           (select count(*) from "update" u where u.repo_id = r.id
              and u.state is not 'pr-merged' and u.state is not 'pr-closed') as pendingCount
      from repo r
     where r.removed_at is null
     order by r.full_name
  `);

  const withFirstFailure = rows.map((row) => {
    const failing = row.lastRunStatus !== null && row.lastRunStatus !== 'success';
    if (!failing) {
      return { ...row, failingSince: null as number | null };
    }
    // The first failure after the last success. With no success on record, the
    // oldest run this repository has.
    const [first] = db.all<{ at: number | null }>(sql`
      select min(rr.completed_at) as at
        from renovate_run rr join repo r on r.id = rr.repo_id
       where r.full_name = ${row.fullName}
         and rr.status != 'success'
         and (${row.lastSuccessAt} is null or rr.completed_at > ${row.lastSuccessAt})
    `);
    return { ...row, failingSince: first?.at ?? null };
  });

  return withFirstFailure.map((row) => ({
    sourceAdapterId: row.sourceAdapterId,
    fullName: row.fullName,
    org: row.org,
    name: row.name,
    stalled: row.stalled === 1,
    lastRunStatus: row.lastRunStatus,
    lastRunAt: row.lastRunAt === null ? null : new Date(row.lastRunAt * 1000),
    lastError: row.lastError,
    failingSince: row.failingSince === null ? null : new Date(row.failingSince * 1000),
    pendingCount: row.pendingCount,
  }));
}

export interface ForgeInfo {
  platform: string | null;
  webBaseUrl: string | null;
}

/**
 * What the sources reported about their forge, keyed by source id.
 *
 * A removed source stays in this map, unlike everywhere else. It is a lookup,
 * not a listing: the pages that read it have already hidden a removed source's
 * rows, and dropping the entry would only break a link on a row that is still
 * reachable by its own address.
 */
export function forges(db: Db): Map<string, ForgeInfo> {
  const rows = db.all<{ id: string; platform: string | null; webBaseUrl: string | null }>(sql`
    select id, platform, web_base_url as webBaseUrl from source
  `);
  return new Map(rows.map((r) => [r.id, { platform: r.platform, webBaseUrl: r.webBaseUrl }]));
}

export interface ForgeRateLimit {
  remaining: number;
  limit: number;
  resetAt: Date | null;
  checkedAt: Date;
}

/**
 * The forge rate-limit headroom Withe last read, or null before the first read
 * (F-10). One row, install-wide: the limit is the GitHub token's, not a source's.
 */
export function forgeRateLimit(db: Db): ForgeRateLimit | null {
  const rows = db.all<{ remaining: number; limit: number; resetAt: number | null; checkedAt: number }>(sql`
    select remaining, "limit", reset_at as resetAt, checked_at as checkedAt from forge_rate_limit where id = 1
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    remaining: row.remaining,
    limit: row.limit,
    resetAt: row.resetAt === null ? null : new Date(row.resetAt * 1000),
    checkedAt: new Date(row.checkedAt * 1000),
  };
}

export interface SourceSystem {
  sourceAdapterId: string;
  kind: string;
  /** Whether this source's kind has a server that reports system facts. A false
   * value means the empty panel is expected, not a setting left off (Task 4.3). */
  reportsSystemFacts: boolean;
  queueDepth: number | null;
  oldestQueuedAt: Date | null;
  oldestQueuedRepo: string | null;
  runnerVersion: string | null;
  bootedAt: Date | null;
}

/**
 * What each source's runner said about itself: queue depth, oldest waiting
 * job, version and boot time (F-08, Task 4.6). All null has two causes now:
 * a server whose system API is off, and a source with no server at all (a log
 * directory). `reportsSystemFacts` separates them — the page points the first
 * at the preflight check and tells the second there is nothing to enable
 * (Task 4.3), instead of an empty panel for either.
 */
export function sourceSystems(db: Db): SourceSystem[] {
  const rows = db.all<{
    sourceAdapterId: string;
    kind: string;
    queueDepth: number | null;
    oldestQueuedAt: number | null;
    oldestQueuedRepo: string | null;
    runnerVersion: string | null;
    bootedAt: number | null;
  }>(sql`
    select id as sourceAdapterId, kind, queue_depth as queueDepth,
           oldest_queued_at as oldestQueuedAt, oldest_queued_repo as oldestQueuedRepo,
           runner_version as runnerVersion, booted_at as bootedAt
      from source
     where removed_at is null
     order by id
  `);
  return rows.map((row) => ({
    ...row,
    reportsSystemFacts: reportsSystemFacts(row.kind as SourceKind),
    oldestQueuedAt: row.oldestQueuedAt === null ? null : new Date(row.oldestQueuedAt * 1000),
    bootedAt: row.bootedAt === null ? null : new Date(row.bootedAt * 1000),
  }));
}

export interface SourceSchedule {
  cron: string | null;
  lastScheduling: Date | null;
}

/** Each source's reported cron and its last scheduling instant, for estimating
 * when the next Renovate run is due (B-5). */
export function schedules(db: Db): SourceSchedule[] {
  const rows = db.all<{ cron: string | null; lastScheduling: number | null }>(sql`
    select schedule_cron as cron, schedule_last_at as lastScheduling
      from source
     where removed_at is null
  `);
  return rows.map((r) => ({
    cron: r.cron,
    lastScheduling: r.lastScheduling ? new Date(r.lastScheduling * 1000) : null,
  }));
}

export interface SourceHealth {
  sourceAdapterId: string;
  kind: string;
  /** The last cycle that actually collected something. */
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  lastOutcome: string | null;
  /** Seconds, because the timestamps are stored in seconds. */
  lastDurationSeconds: number | null;
  lastError: string | null;
  attemptsInWindow: number;
  failuresInWindow: number;
}

/**
 * What each source has been doing, for `/health` and `/api/health`.
 *
 * `since` bounds the two counts. A failure count over all time says nothing
 * about whether a source is healthy now — a server that broke in June and has
 * worked ever since would read as broken forever.
 */
export function sourceHealth(db: Db, since: Date): SourceHealth[] {
  const cutoff = Math.floor(since.getTime() / 1000);
  const rows = db.all<{
    sourceAdapterId: string;
    kind: string;
    lastSuccessAt: number | null;
    lastAttemptAt: number | null;
    lastOutcome: string | null;
    lastStartedAt: number | null;
    lastFinishedAt: number | null;
    lastError: string | null;
    attemptsInWindow: number;
    failuresInWindow: number;
  }>(sql`
    select s.id as sourceAdapterId,
           s.kind as kind,
           (select max(ss.finished_at) from sync_status ss
             where ss.source_adapter_id = s.id and ss.outcome in ('ok', 'partial')) as lastSuccessAt,
           (select max(ss.started_at) from sync_status ss
             where ss.source_adapter_id = s.id) as lastAttemptAt,
           (select ss.outcome from sync_status ss
             where ss.source_adapter_id = s.id order by ss.id desc limit 1) as lastOutcome,
           (select ss.started_at from sync_status ss
             where ss.source_adapter_id = s.id order by ss.id desc limit 1) as lastStartedAt,
           (select ss.finished_at from sync_status ss
             where ss.source_adapter_id = s.id order by ss.id desc limit 1) as lastFinishedAt,
           (select ss.error from sync_status ss
             where ss.source_adapter_id = s.id and ss.error is not null
             order by ss.id desc limit 1) as lastError,
           (select count(*) from sync_status ss
             where ss.source_adapter_id = s.id and ss.started_at >= ${cutoff}) as attemptsInWindow,
           (select count(*) from sync_status ss
             where ss.source_adapter_id = s.id and ss.started_at >= ${cutoff}
               and ss.outcome = 'failed') as failuresInWindow
      from source s
     where s.removed_at is null
     order by s.id
  `);

  return rows.map((row) => ({
    sourceAdapterId: row.sourceAdapterId,
    kind: row.kind,
    lastSuccessAt: row.lastSuccessAt === null ? null : new Date(row.lastSuccessAt * 1000),
    lastAttemptAt: row.lastAttemptAt === null ? null : new Date(row.lastAttemptAt * 1000),
    lastOutcome: row.lastOutcome,
    lastDurationSeconds:
      row.lastStartedAt === null || row.lastFinishedAt === null
        ? null
        : row.lastFinishedAt - row.lastStartedAt,
    lastError: row.lastError,
    attemptsInWindow: row.attemptsInWindow,
    failuresInWindow: row.failuresInWindow,
  }));
}

export interface MigrationState {
  applied: number;
  /**
   * When the newest applied migration was **written**, not when it ran.
   * Drizzle stores the journal's `when`, so this identifies the schema rather
   * than the install.
   */
  newestAt: Date | null;
}

/**
 * Which migrations this database has. A bug report that states this saves the
 * first two questions of answering it.
 */
export function migrationState(db: Db): MigrationState {
  const [row] = db.all<{ applied: number; latestAt: number | null }>(sql`
    select count(*) as applied, max(created_at) as latestAt from __drizzle_migrations
  `);
  return {
    applied: row?.applied ?? 0,
    // Drizzle records this one in milliseconds, unlike every other timestamp here.
    newestAt: row?.latestAt ? new Date(row.latestAt) : null,
  };
}
