/**
 * The store. One SQLite file, five tables, every domain row tagged with the
 * source that produced it.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const source = sqliteTable('source', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['ce', 'jsonlog', 'forge'] }).notNull(),
  label: text('label'),
  /** The forge the source works against, as it reported it. */
  platform: text('platform'),
  /** Browsable base URL for that forge, derived from its API endpoint. */
  webBaseUrl: text('web_base_url'),
  lastSyncAt: integer('last_sync_at', { mode: 'timestamp' }),
  lastSyncOutcome: text('last_sync_outcome', { enum: ['ok', 'partial', 'failed'] }),
  /** The runner's own cron, as it reported it, so the next run can be estimated
   * from the source rather than from a value Withe was told (B-5). */
  scheduleCron: text('schedule_cron'),
  /** When that cron last scheduled — the absolute instant the next run is
   * projected from, which keeps the estimate free of the runner's timezone. */
  scheduleLastAt: integer('schedule_last_at', { mode: 'timestamp' }),
});

export const repo = sqliteTable(
  'repo',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceAdapterId: text('source_adapter_id')
      .notNull()
      .references(() => source.id),
    org: text('org').notNull(),
    name: text('name').notNull(),
    fullName: text('full_name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    installStatus: text('install_status'),
    queueName: text('queue_name'),
    installedAt: integer('installed_at', { mode: 'timestamp' }),
    removedAt: integer('removed_at', { mode: 'timestamp' }),
    stalled: integer('stalled', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [uniqueIndex('repo_source_full').on(t.sourceAdapterId, t.fullName)],
);

export const renovateRun = sqliteTable(
  'renovate_run',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceAdapterId: text('source_adapter_id')
      .notNull()
      .references(() => source.id),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repo.id),
    externalJobId: text('external_job_id').notNull(),
    reason: text('reason'),
    queuedAt: integer('queued_at', { mode: 'timestamp' }),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    status: text('status', {
      enum: ['queued', 'running', 'success', 'failed', 'unknown'],
    }).notNull(),
    error: text('error'),
    artifactErrors: text('artifact_errors', { mode: 'json' }).$type<string[]>(),
    logLocation: text('log_location'),
    /**
     * Which Renovate produced the run. Not in tad.md 5.1; added because a later
     * change in log shape must be attributable to a version rather than being a
     * mystery. Task 1.11 reads it from the log.
     */
    runnerVersion: text('runner_version'),
    /**
     * Whether the source still holds this run's log.
     *
     * Withe keeps run metadata indefinitely and the source does not, so within
     * weeks the history lists runs whose logs are gone. A run that stops
     * appearing in the source's job list has been purged there, which is how
     * this is computed — no extra request per run. The viewer greys the link
     * rather than opening a 404 (F-06).
     */
    logAvailable: integer('log_available', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [
    uniqueIndex('run_source_ext').on(t.sourceAdapterId, t.externalJobId),
    index('run_repo_completed').on(t.repoId, t.completedAt),
  ],
);

export const update = sqliteTable(
  'update',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceAdapterId: text('source_adapter_id')
      .notNull()
      .references(() => source.id),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repo.id),
    dependencyName: text('dependency_name').notNull(),
    currentVersion: text('current_version'),
    targetVersion: text('target_version'),
    updateType: text('update_type', {
      enum: [
        'digest',
        'patch',
        'minor',
        'major',
        'multiple-major',
        'security',
        'lock-file-maintenance',
      ],
    }),
    datasource: text('datasource'),
    packageName: text('package_name'),
    state: text('state', { enum: ['detected', 'pr-open', 'pr-merged', 'pr-closed'] }),
    prUrl: text('pr_url'),
    prNumber: integer('pr_number'),
    closedAt: integer('closed_at', { mode: 'timestamp' }),
    closeType: text('close_type', { enum: ['merge', 'close'] }),
    detectedAt: integer('detected_at', { mode: 'timestamp' }),
    /**
     * How many package files carry this same dependency at this same version.
     * The live probe found one dependency seven times in one repository, and
     * Task 1.8 shows one row with a count rather than seven rows.
     */
    packageFileCount: integer('package_file_count').notNull().default(1),
    /**
     * Those package files by path, as a JSON array. Null on rows written
     * before the column existed. For a repository the source still lists,
     * persist rewrites its update set every sync, so the null clears within
     * one interval and needs no backfill; a repository the source dropped
     * keeps its rows — and this null — which the reader shows as no paths.
     */
    packageFiles: text('package_files', { mode: 'json' }).$type<string[]>(),
  },
  (t) => [
    // Every sync re-reads the same pending updates. Without a natural key the
    // table grows by the whole update set on every pass.
    uniqueIndex('update_natural').on(
      t.sourceAdapterId,
      t.repoId,
      t.dependencyName,
      t.currentVersion,
      t.targetVersion,
      t.updateType,
    ),
  ],
);

export const syncStatus = sqliteTable('sync_status', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceAdapterId: text('source_adapter_id')
    .notNull()
    .references(() => source.id),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
  outcome: text('outcome', { enum: ['ok', 'partial', 'failed'] }).notNull(),
  error: text('error'),
  repoCount: integer('repo_count'),
  runCount: integer('run_count'),
});
