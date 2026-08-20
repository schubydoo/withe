/**
 * Recover pending updates from a Renovate run log.
 *
 * This lives in core rather than in an adapter because the log is the runner's
 * output, not any one distribution's. A server API serves it over HTTP and a
 * plain container writes it to a file; both produce these same lines, and the
 * v1.1 file adapter reads this same function.
 *
 * Lines are recognised by the fields they carry, never by their message text.
 * Message wording belongs to Renovate and changes without notice; the field
 * shapes are what the log is for.
 */
import type { Update, UpdateState, UpdateType } from './model.ts';

/** One entry inside `branchesInformation[].upgrades`. */
interface RawUpgrade {
  depName?: string;
  packageName?: string;
  currentValue?: string;
  currentVersion?: string;
  newValue?: string;
  newVersion?: string;
  updateType?: string;
  packageFile?: string;
  isVulnerabilityAlert?: boolean;
  /** Where the source looked this up. Decides what a link can point at. */
  datasource?: string;
}

interface RawBranch {
  branchName?: string;
  prNo?: number;
  prTitle?: string;
  result?: string;
  upgrades?: RawUpgrade[];
}

export interface AbandonedPackage {
  dependency: string;
  lastReleaseAt: Date | null;
}

export interface UpdateTotals {
  total: number;
  vulnerabilityAlerts: number;
  byType: Record<string, number>;
}

export interface LogExtract {
  /** Which Renovate produced the run, so a later shape change has a version. */
  runnerVersion: string | null;
  updates: Update[];
  abandoned: AbandonedPackage[];
  /**
   * The run's own totals. Null when the log carries no summary, which means the
   * run found nothing pending, not that anything went wrong.
   */
  totals: UpdateTotals | null;
}

export interface ExtractContext {
  repoId: string;
  sourceAdapterId: string;
  /** When the run happened. Every update it reports was pending then. */
  detectedAt: Date;
}

/**
 * Classify one upgrade.
 *
 * PRD Section 6.3 fixes the order: a security label wins over everything, then
 * a major difference, then `multiple-major` when the major delta exceeds one,
 * then minor, then patch, with digests matched by /^[a-f0-9]{7,40}$/.
 */
export function classify(upgrade: RawUpgrade): UpdateType {
  if (upgrade.isVulnerabilityAlert) return 'security';

  const raw = upgrade.updateType;
  if (raw === 'lockFileMaintenance') return 'lock-file-maintenance';
  if (raw === 'digest' || raw === 'pin' || raw === 'pinDigest') return 'digest';

  const current = upgrade.currentVersion ?? upgrade.currentValue;
  const next = upgrade.newVersion ?? upgrade.newValue;

  if (raw === 'major') {
    return majorDelta(current, next) > 1 ? 'multiple-major' : 'major';
  }
  if (raw === 'minor') return 'minor';
  if (raw === 'patch') return 'patch';

  // No usable label. Fall back to the versions themselves, and to a digest when
  // the value looks like a hash rather than a version.
  if (next && /^[a-f0-9]{7,40}$/.test(next)) return 'digest';
  const delta = majorDelta(current, next);
  if (delta > 1) return 'multiple-major';
  if (delta === 1) return 'major';
  return 'patch';
}

function majorOf(version: string | undefined | null): number | null {
  if (!version) return null;
  const match = /^v?(\d+)/.exec(version.trim());
  return match?.[1] ? Number(match[1]) : null;
}

function majorDelta(current: string | undefined, next: string | undefined): number {
  const a = majorOf(current);
  const b = majorOf(next);
  if (a === null || b === null) return 0;
  return Math.abs(b - a);
}

/**
 * Whether an update waits for a person.
 *
 * Decided from the update itself: a major, or a minor below 1.0, where the
 * ecosystem treats a minor as breaking. Reading the operator's preset
 * repository to answer this would tie Withe to one person's configuration and
 * to a forge it may not be able to reach.
 */
export function isHeld(update: Pick<Update, 'updateType' | 'currentVersion'>): boolean {
  if (update.updateType === 'major' || update.updateType === 'multiple-major') return true;
  if (update.updateType !== 'minor') return false;
  return majorOf(update.currentVersion) === 0;
}

function stateOf(branch: RawBranch): UpdateState {
  return typeof branch.prNo === 'number' ? 'pr-open' : 'detected';
}

/** Read an NDJSON log and return what it says about pending updates. */
export async function extractFromLog(
  source: AsyncIterable<Uint8Array | string>,
  context: ExtractContext,
): Promise<LogExtract> {
  let runnerVersion: string | null = null;
  let totals: UpdateTotals | null = null;

  // One dependency at one version pair appears once per package file. The live
  // probe found the same one seven times in a single repository, so the rows
  // are merged here and the file count is carried on the row.
  const byKey = new Map<string, Update>();
  const filesByKey = new Map<string, Set<string>>();
  const abandoned = new Map<string, Date | null>();

  for await (const entry of ndjson(source)) {
    if (!runnerVersion && typeof entry.renovateVersion === 'string') {
      runnerVersion = entry.renovateVersion;
    }

    const summary = entry.updateSummary;
    if (Array.isArray(summary) && summary.length > 0) {
      const first = summary[0] as Record<string, unknown>;
      totals = {
        total: Number(first.total ?? 0),
        vulnerabilityAlerts: Number(first.vulnerabilityAlert ?? 0),
        byType: (first.updates as Record<string, number>) ?? {},
      };
    }

    const branches = entry.branchesInformation;
    if (Array.isArray(branches)) {
      for (const branch of branches as RawBranch[]) {
        for (const upgrade of branch.upgrades ?? []) {
          const updateType = classify(upgrade);
          // A lock-file refresh names no dependency, because it updates every
          // transitive pin at once. One branch refreshes every manifest it
          // covers, so the branch names the row and the manifests are counted
          // on it. Naming the row for the manifest instead reported a 14-crate
          // Cargo workspace as 14 pending refreshes. Dropping these entirely
          // would lose most of the pending work: 7 of 9 on the author's
          // install.
          const name =
            upgrade.depName ??
            upgrade.packageName ??
            (updateType === 'lock-file-maintenance'
              ? (branch.branchName ?? upgrade.packageFile)
              : undefined);
          if (!name) continue;

          const currentVersion = upgrade.currentValue ?? upgrade.currentVersion ?? null;
          const targetVersion = upgrade.newValue ?? upgrade.newVersion ?? null;
          const key = [name, currentVersion, targetVersion, updateType].join('\0');

          const files = filesByKey.get(key) ?? new Set<string>();
          if (upgrade.packageFile) files.add(upgrade.packageFile);
          filesByKey.set(key, files);

          const existing = byKey.get(key);
          if (existing) {
            // A pull request number seen on any branch of the group applies to
            // the merged row.
            if (existing.pullRequestNumber === null && typeof branch.prNo === 'number') {
              existing.pullRequestNumber = branch.prNo;
              existing.state = 'pr-open';
            }
            continue;
          }

          byKey.set(key, {
            id: `${context.sourceAdapterId}:${context.repoId}:${key.replaceAll('\0', ':')}`,
            repoId: context.repoId,
            dependencyName: name,
            currentVersion,
            targetVersion,
            updateType,
            datasource: upgrade.datasource ?? null,
            // The registry name, not the display name: Renovate shows `uv` and
            // looks up `astral-sh/uv`, and only the latter can be linked.
            packageName: upgrade.packageName ?? upgrade.depName ?? null,
            state: stateOf(branch),
            pullRequestUrl: null,
            pullRequestNumber: branch.prNo ?? null,
            closedAt: null,
            closeType: null,
            detectedAt: context.detectedAt,
            packageFileCount: 1,
            packageFiles: [],
            sourceAdapterId: context.sourceAdapterId,
          });
        }
      }
    }

    const outcome = entry.result;
    if (
      outcome &&
      typeof outcome === 'object' &&
      (outcome as Record<string, unknown>).isAbandoned === true &&
      typeof entry.dependency === 'string'
    ) {
      const timestamp = (outcome as Record<string, unknown>).mostRecentTimestamp;
      abandoned.set(entry.dependency, typeof timestamp === 'string' ? new Date(timestamp) : null);
    }
  }

  for (const [key, update] of byKey) {
    const files = filesByKey.get(key);
    update.packageFileCount = Math.max(1, files?.size ?? 1);
    // Sorted so the same log always produces the same row, whatever order the
    // branches reported the manifests in.
    update.packageFiles = files ? [...files].sort() : [];
  }

  return {
    runnerVersion,
    totals,
    updates: [...byKey.values()],
    abandoned: [...abandoned].map(([dependency, lastReleaseAt]) => ({ dependency, lastReleaseAt })),
  };
}

/** Split a byte or string stream into parsed NDJSON objects, tolerating junk. */
async function* ndjson(
  source: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const parsed = parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (parsed) yield parsed;
      newline = buffer.indexOf('\n');
    }
  }

  const last = parse(buffer);
  if (last) yield last;
}

function parse(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    // A log can carry a line that is not JSON. Skipping it is right: a whole
    // run's updates should not be lost to one malformed entry.
    return null;
  }
}
