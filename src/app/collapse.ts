/**
 * Merge the copies of one pending update or lock-file refresh that two sources
 * both reported (Q-7, Task 4.8).
 *
 * The facts split across copies: a forge lives on the server's row (a log
 * directory has none), while the pull request can be on whichever source saw it
 * first — a fresher log directory can carry a PR a stale server has not caught
 * up to. Keeping one whole row loses whichever fact is on the other, so these
 * take the group and build one row: the base is a copy whose source has a forge,
 * so `info()` can link the repository and PR; the pull request and the fuller
 * manifest count are filled from any copy that has them.
 */
import type { ForgeInfo, LockFileRefreshRow, PendingUpdateRow } from '../db/queries.ts';

/** A copy whose source reports a forge, so the page can build links from it; the
 * first copy otherwise (all-null links either way). */
function forgeBearing<T extends { sourceAdapterId: string }>(group: T[], forge: Map<string, ForgeInfo>): T {
  return group.find((row) => forge.get(row.sourceAdapterId)?.webBaseUrl != null) ?? group[0]!;
}

function firstPr(group: Array<{ prNumber: number | null }>): number | null {
  return group.find((row) => row.prNumber !== null)?.prNumber ?? null;
}

export function foldUpdate(group: PendingUpdateRow[], forge: Map<string, ForgeInfo>): PendingUpdateRow {
  const base = forgeBearing(group, forge);
  return {
    ...base,
    prNumber: base.prNumber ?? firstPr(group),
    packageFileCount: Math.max(...group.map((row) => row.packageFileCount)),
  };
}

export function foldLock(group: LockFileRefreshRow[], forge: Map<string, ForgeInfo>): LockFileRefreshRow {
  const base = forgeBearing(group, forge);
  // The manifests a refresh covers can be fuller on one copy than another; keep
  // the longest list and its count.
  const fullest = group.reduce((a, b) => (b.packageFiles.length > a.packageFiles.length ? b : a));
  return {
    ...base,
    prNumber: base.prNumber ?? firstPr(group),
    packageFileCount: Math.max(...group.map((row) => row.packageFileCount)),
    packageFiles: fullest.packageFiles,
  };
}
