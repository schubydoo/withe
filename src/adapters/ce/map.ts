/**
 * The only file that knows both vocabularies.
 *
 * Everything above this file speaks the internal model; the generated types
 * stop here. Every function is pure so that mapping is testable against
 * recorded responses with no server and no database.
 */
import type { RenovateRun, Repo, RepoInstallStatus, RunStatus } from '../../core/model.ts';
import type { components } from './generated/ce.d.ts';

type OrgMeta = components['schemas']['OrgMeta'];
type RepositoryInfo = components['schemas']['RepositoryInfo'];
type JobReport = components['schemas']['JobReport'];

/** Parse a date the source may have omitted. */
function toDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The source reports eight installation states and the model carries six.
 *
 * `failed`, `resource-limit` and `timeout` describe why onboarding did not
 * finish. They have no source-agnostic equivalent, so they land on `unknown`
 * rather than being invented into the model. The run record carries the same
 * information in a form every adapter can produce.
 */
export function mapInstallStatus(status: RepositoryInfo['status']): RepoInstallStatus {
  switch (status) {
    case 'activated':
    case 'onboarded':
    case 'onboarding':
    case 'disabled':
      return status;
    default:
      return 'unknown';
  }
}

/**
 * Job status is an open string in the specification, not an enum.
 *
 * Anything unrecognised becomes `unknown` rather than `failed`. Guessing the
 * other way would invent failures, and F-04 leads with failures.
 */
export function mapRunStatus(status: string | undefined): RunStatus {
  switch (status) {
    case 'success':
      return 'success';
    case 'error':
    case 'failed':
    case 'failure':
      return 'failed';
    case 'pending':
    case 'queued':
      return 'queued';
    case 'in-progress':
    case 'running':
      return 'running';
    default:
      return 'unknown';
  }
}

/**
 * Flatten the source's error object into one line.
 *
 * The source returns `{ name, message }`; the model holds a string, because a
 * log-file adapter has only a line of text to offer and F-02 requires both to
 * produce the same shape.
 */
export function mapError(error: JobReport['error']): string | null {
  if (!error) return null;
  const name = error.name?.trim();
  const message = error.message?.trim();
  if (name && message) return `${name}: ${message}`;
  return message || name || null;
}

/**
 * Flatten artifact errors into lines.
 *
 * The source returns an object keyed by something it does not document, whose
 * values are arrays of `{ fileName, lockFile, stderr }`. Every field is
 * optional, so a line is assembled from whichever are present and an entry that
 * says nothing is dropped rather than rendered as an empty bullet.
 */
export function mapArtifactErrors(errors: JobReport['artifactErrors']): string[] {
  if (!errors || typeof errors !== 'object') return [];

  const lines: string[] = [];
  for (const [group, entries] of Object.entries(errors)) {
    for (const entry of entries ?? []) {
      const where = entry.fileName ?? entry.lockFile ?? group;
      const why = entry.stderr?.trim();
      if (where && why) lines.push(`${where}: ${why}`);
      else if (why) lines.push(why);
      else if (entry.fileName ?? entry.lockFile) lines.push(String(where));
    }
  }
  return lines;
}

export function mapRepo(
  org: string,
  info: RepositoryInfo,
  sourceAdapterId: string,
): Repo {
  return {
    id: `${sourceAdapterId}:${info.fullName}`,
    org,
    name: info.name,
    fullName: info.fullName,
    enabled: info.enabled,
    installStatus: mapInstallStatus(info.status),
    queueName: info.queueName ?? null,
    installedAt: toDate(info.installedAt),
    removedAt: toDate(info.removedAt),
    sourceAdapterId,
  };
}

export function mapOrgName(org: OrgMeta): string {
  return org.name;
}

export function mapRun(
  repoId: string,
  job: JobReport,
  sourceAdapterId: string,
): RenovateRun | null {
  // jobId is optional in the specification. A run Withe cannot address again is
  // not a run it can store, because the unique key depends on it.
  if (!job.jobId) return null;

  return {
    id: `${sourceAdapterId}:${job.jobId}`,
    repoId,
    externalJobId: String(job.jobId),
    triggerReason: job.reason ?? null,
    queuedAt: toDate(job.addedAt),
    startedAt: toDate(job.startedAt),
    completedAt: toDate(job.completedAt),
    status: mapRunStatus(job.status),
    error: mapError(job.error),
    artifactErrors: mapArtifactErrors(job.artifactErrors),
    logLocation: job.logLocation ?? null,
    // The jobs endpoint does not report it. Task 1.11 fills this in from the log.
    runnerVersion: null,
    sourceAdapterId,
  };
}
