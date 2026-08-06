/**
 * The internal, source-agnostic model.
 *
 * Nothing here names a Renovate distribution, an API, or a forge. F-02 depends
 * on that: a self-hosted server API, a directory of JSON logs, and a forge API
 * must all produce these same three shapes, and a reviewer checks the rule by
 * grepping this file for adapter vocabulary and finding none.
 */

/**
 * Which configured source produced a record.
 *
 * Two adapters can describe the same repository — a server API and a log
 * directory watching the same runner — and this is the field that keeps them
 * apart. It is stable, comes from configuration, and is never derived from
 * anything the source returns.
 */
export type SourceAdapterId = string;

/** Where a repository stands with the runner that observes it. */
export type RepoInstallStatus =
  | 'activated'
  | 'onboarded'
  | 'onboarding'
  | 'disabled'
  | 'removed'
  | 'unknown';

export interface Repo {
  id: string;
  org: string;
  name: string;
  /** `org/name`, as the forge writes it. */
  fullName: string;
  enabled: boolean;
  installStatus: RepoInstallStatus;
  /** The runner's queue, when it has queues. Null when the source has none. */
  queueName: string | null;
  installedAt: Date | null;
  removedAt: Date | null;
  sourceAdapterId: SourceAdapterId;
}

/** The outcome of one run against one repository. */
export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'unknown';

export interface RenovateRun {
  id: string;
  repoId: string;
  /** The source's own identifier for the run. Opaque; never parsed. */
  externalJobId: string;
  /** Why the run happened, in the source's words. */
  triggerReason: string | null;
  queuedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  status: RunStatus;
  /** A run-level failure. Absent on every healthy run. */
  error: string | null;
  /**
   * Failures to update a lock file or vendored artifact. A run can succeed and
   * still carry these, which is why they are separate from `error`.
   */
  artifactErrors: string[];
  /**
   * Where the source keeps this run's log. Opaque to Withe: a path on the
   * runner's disk, a URL, or null. Logs are fetched on demand and never stored
   * (PRD Section 6.3.1).
   */
  logLocation: string | null;
  /** The runner version that produced the run, when the source reports it. */
  runnerVersion: string | null;
  sourceAdapterId: SourceAdapterId;
}

/**
 * How big a change an update is.
 *
 * The first six values and their classification order come from PRD Section
 * 6.3: security wins over everything, then a major-version difference, then
 * `multiple-major` when the major delta exceeds one, then minor, then patch,
 * with digests matched by /^[a-f0-9]{7,40}$/.
 *
 * `lock-file-maintenance` is a seventh value, added on 2026-08-06 because the
 * live probe found it in the data: 20 of 34 pending updates on the author's
 * own install were lock-file refreshes. It names no dependency version change,
 * so it cannot be classified into the other six, and dropping it would silently
 * lose most of the rows. Task 1.8 counts these and does not list them.
 */
export type UpdateType =
  | 'digest'
  | 'patch'
  | 'minor'
  | 'major'
  | 'multiple-major'
  | 'security'
  | 'lock-file-maintenance';

/** Where an update sits between detected and finished. */
export type UpdateState =
  | 'pending'
  | 'open'
  | 'merged'
  | 'closed';

/** Why an update stopped being open. */
export type UpdateCloseType = 'merged' | 'declined' | 'superseded';

export interface Update {
  id: string;
  repoId: string;
  dependencyName: string;
  /** The version in the repository now. Null when the source omits it. */
  currentVersion: string | null;
  /** The version the update moves to. Null for a lock-file refresh. */
  targetVersion: string | null;
  updateType: UpdateType;
  state: UpdateState;
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
  closedAt: Date | null;
  closeType: UpdateCloseType | null;
  detectedAt: Date;
  sourceAdapterId: SourceAdapterId;
}
